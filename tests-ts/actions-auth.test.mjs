import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from 'jose';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';

const issuer = 'https://token.actions.githubusercontent.com';
test('OIDC exchange binds identity and scope, persists issuance guards and never archives credentials', async t => {
  // The Worker's dashboard configuration becomes the first access rule: collect.yml on main, purposes source and target.
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/actions-auth-'));
  const oidc = await generateKeyPair('RS256'), app = await generateKeyPair('RS256', { extractable: true });
  const key = { ...await exportJWK(oidc.publicKey), kid: 'actions-key', alg: 'RS256', use: 'sig' };
  const destination = 'example/board-test', source = 'example/source-test', audience = 'sdbot:actions:test';
  const bindings = { SDBOT_GITHUB_WEBHOOK_SECRET: 'isolated-webhook', SDBOT_GITHUB_APP_PRIVATE_KEY: await exportPKCS8(app.privateKey),
    SDBOT_GITHUB_APP_ID: '123', SDBOT_REPOS: source, SDBOT_BOARD_TARGETS: JSON.stringify({ [source]: destination }),
    SDBOT_ADMIN_HOSTNAME: 'localhost', SDBOT_ACTIONS_REPOSITORY_ID: '200', SDBOT_ACTIONS_OWNER_ID: '100', SDBOT_ACTIONS_AUDIENCE: audience };
  const calls = []; let failure = false;
  const outboundService = async request => {
    if (request.url === issuer + '/.well-known/jwks') return Response.json({ keys: [key] });
    assert.equal(new URL(request.url).origin, 'https://api.github.com');
    calls.push({ url: request.url, body: request.method === 'POST' ? await request.json() : null });
    if (failure) return new Response('private-upstream-error', { status: 403 });
    if (request.url.endsWith('/installation')) return Response.json({ id: request.url.includes('source-test') ? 11 : 22 });
    // Pinning a rule's workflow repository reads its immutable IDs.
    if (request.method === 'GET' && /\/repos\/example\/tools$/.test(request.url)) return Response.json({ id: 300, full_name: 'example/tools', owner: { id: 100 } });
    return Response.json({ token: 'scoped-secret-' + calls.length, expires_at: new Date(Date.now() + 3600000).toISOString() });
  };
  let mf = await workerRuntime({ directory, bindings, outboundService });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const token = (overrides = {}, privateKey = oidc.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: issuer, aud: audience, sub: `repo:example@100/board-test@200:ref:refs/heads/main`,
      iat: now, nbf: now, exp: now + 300, jti: crypto.randomUUID(), repository: destination, repository_id: '200', repository_owner_id: '100',
      ref: 'refs/heads/main', ref_type: 'branch', workflow_ref: destination + '/.github/workflows/collect.yml@refs/heads/main',
      job_workflow_ref: destination + '/.github/workflows/collect.yml@refs/heads/main',
      event_name: 'workflow_dispatch', run_id: '300', run_attempt: '1', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: key.kid }).sign(privateKey);
  };
  const exchange = (jwt, purpose = 'source', options = {}) => mf.dispatchFetch('http://localhost/actions/token', {
    method: 'POST', headers: { authorization: 'Bearer ' + jwt }, body: JSON.stringify({ purpose }), ...options });
  assert.equal((await exchange('invented')).status, 401);
  for (const override of [{ aud: 'sdbot:actions:production' }, { iss: 'https://evil.test' }, { exp: 1 }, { exp: undefined },
    { nbf: Math.floor(Date.now() / 1000) + 60 }, { iat: 1 }, { jti: undefined }]) {
    assert.equal((await exchange(await token(override))).status, 401);
  }
  const wrong = await generateKeyPair('RS256');
  assert.equal((await exchange(await token({}, wrong.privateKey))).status, 401);
  for (const override of [{ repository: 'example/board' }, { repository_id: '201' }, { repository_owner_id: '101' },
    { sub: 'repo:example/board-test:pull_request' }, { ref: 'refs/pull/1/merge' }, { ref_type: 'tag' },
    { workflow_ref: destination + '/.github/workflows/evil.yml@refs/heads/main' }, { job_workflow_ref: 'other/workflow' },
    { event_name: 'pull_request_target' }, { run_attempt: '0' }, { run_id: undefined }]) {
    assert.equal((await exchange(await token(override))).status, 403);
  }
  const jwt = await token();
  assert.equal((await exchange(jwt, 'Admin!')).status, 400);
  const unknown = await exchange(jwt, 'admin');
  assert.deepEqual([unknown.status, (await unknown.json()).error], [403, 'purpose not allowed for this workflow']);
  assert.equal((await exchange(jwt, 'source', { body: JSON.stringify({ purpose: 'source', repository: 'example/other' }) })).status, 400);
  assert.equal((await exchange(jwt, 'source', { body: 'x'.repeat(300) })).status, 413);
  assert.equal((await mf.dispatchFetch('http://other.test/actions/token', { method: 'POST', headers: { authorization: 'Bearer ' + jwt } })).status, 401);
  assert.equal((await mf.dispatchFetch('http://localhost/actions/token')).status, 405);
  assert.equal(calls.length, 0);
  const results = await Promise.all([exchange(jwt), exchange(jwt)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const response = results.find(r => r.status === 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const grant = await response.json(); assert.equal(grant.repository, source); assert.ok(grant.expires_at); assert.equal(grant.purpose, 'source');
  // The response keeps its shape; the record that is also written appears below.
  assert.deepEqual(Object.keys(grant).sort(), ['expires_at', 'permissions', 'purpose', 'repository', 'token']);
  assert.deepEqual(calls[1].body, { repositories: ['source-test'], permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' } });
  const target = await exchange(jwt, 'target'); assert.equal(target.status, 200); assert.equal((await target.json()).repository, destination);
  assert.deepEqual(calls[3].body, { repositories: ['board-test'], permissions: { metadata: 'read', contents: 'write' } });
  assert.match(calls[1].url, /installations\/11/); assert.match(calls[3].url, /installations\/22/);
  await mf.dispose(); mf = await workerRuntime({ directory, bindings, outboundService });
  assert.equal((await exchange(await token())).status, 409); // Fresh JWT cannot bypass the run-attempt guard.
  assert.equal((await exchange(await token({ run_attempt: '2', job_workflow_ref: undefined, event_name: 'schedule', sub: `repo:${destination}:ref:refs/heads/main` }))).status, 200);
  failure = true;
  const failed = await exchange(await token({ run_attempt: '3' })); assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private-upstream|scoped-secret/);
  assert.equal((await mf.dispatchFetch('http://localhost/actions/unknown', { method: 'POST', body: 'credential-not-a-webhook' })).status, 404);
  const events = await mf.getDurableObjectNamespace('BOT', 'bot');
  const status = await (await events.get(events.idFromName('archive-v1')).query('/api/events')).json();
  assert.equal(status.count, 0);
  // Each issued token is listed with its GitHub expiry, run identity, purpose and repository; never the token, and not the 409 or 502.
  const issued = (await events.get(events.idFromName('archive-v1')).tokenGrants()).grants;
  assert.deepEqual(issued.map(g => [g.source, g.identity, g.purpose, g.repository]), [
    ['actions', `看板采集 · ${destination} run 300#2`, 'source', source], ['actions', `看板采集 · ${destination} run 300#1`, 'target', destination], ['actions', `看板采集 · ${destination} run 300#1`, 'source', source]]);
  assert.ok(issued.every(g => Date.parse(g.expires_at) > Date.now() + 3000000), 'the installation token expiry, not the five-minute OIDC exp');
  assert.deepEqual(issued.map(g => g.permissions), ['metadata:read, contents:read, issues:read, pull_requests:read, actions:read, checks:read, statuses:read',
    'metadata:read, contents:write', 'metadata:read, contents:read, issues:read, pull_requests:read, actions:read, checks:read, statuses:read']);
  assert.doesNotMatch(JSON.stringify(issued), /scoped-secret/);
  // Later rules: their own workflow, branch and events, several tokens with their own repositories and permissions.
  failure = false;
  const bot = events.get(events.idFromName('archive-v1'));
  const added = await bot.actionsRulesAdmin('POST', null, { name: 'Release site', repository: 'example/tools', workflow: '.github/workflows/release.yml', branch: 'release',
    events: ['push'], grants: [{ purpose: 'publish', repository: 'example/site', permissions: { contents: 'write', pages: 'write' } },
      { purpose: 'read-source', repository: source, permissions: { contents: 'read' } }] });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.rule.repository, added.body.rule.repository_id, added.body.rule.owner_id], ['example/tools', '300', '100']);
  const tools = (overrides = {}) => token({ repository: 'example/tools', repository_id: '300', sub: 'repo:example/tools:ref:refs/heads/release', ref: 'refs/heads/release',
    workflow_ref: 'example/tools/.github/workflows/release.yml@refs/heads/release', job_workflow_ref: undefined, event_name: 'push', run_id: '500', ...overrides });
  const before = calls.length, release = await tools();
  const published = await exchange(release, 'publish');
  assert.equal(published.status, 200);
  assert.deepEqual(await published.json().then(g => [g.repository, g.permissions]), ['example/site', { metadata: 'read', contents: 'write', pages: 'write' }]);
  assert.equal((await exchange(release, 'read-source')).status, 200);
  assert.deepEqual(calls.slice(before).filter(c => c.url.endsWith('/access_tokens')).map(c => c.body),
    [{ repositories: ['site'], permissions: { metadata: 'read', contents: 'write', pages: 'write' } }, { repositories: ['source-test'], permissions: { metadata: 'read', contents: 'read' } }]);
  assert.equal((await exchange(release, 'publish')).status, 409, 'once per run attempt and purpose');
  // Purposes belong to their rule; the identity must match every part of it.
  assert.equal((await exchange(await tools({ run_id: '501' }), 'target')).status, 403);
  for (const [label, overrides] of [['event', { run_id: '502', event_name: 'workflow_dispatch' }], ['branch', { run_id: '503', ref: 'refs/heads/main', sub: 'repo:example/tools:ref:refs/heads/main', workflow_ref: 'example/tools/.github/workflows/release.yml@refs/heads/main' }],
    ['workflow file', { run_id: '504', workflow_ref: 'example/tools/.github/workflows/other.yml@refs/heads/release' }], ['reusable workflow', { run_id: '505', job_workflow_ref: 'evil/lib/.github/workflows/x.yml@main' }],
    ['repository id', { run_id: '506', repository_id: '301' }], ['owner id', { run_id: '507', repository_owner_id: '101' }]]) {
    assert.equal((await exchange(await tools(overrides), 'publish')).status, 403, label);
  }
  // A renamed repository keeps its IDs and still matches; a new repository under the old name would not.
  const renamed = await tools({ run_id: '508', repository: 'example/tools-renamed', sub: 'repo:example/tools-renamed:ref:refs/heads/release', workflow_ref: 'example/tools-renamed/.github/workflows/release.yml@refs/heads/release' });
  assert.equal((await exchange(renamed, 'publish')).status, 200);
  assert.equal((await bot.tokenGrants()).grants[0].identity, 'Release site · example/tools-renamed run 508#1');
  // Deleting a rule ends its exchanges, and a restart does not seed it again.
  const boardRule = (await bot.actionsRulesAdmin('GET', null, null)).body.rules.find(r => r.name === '看板采集');
  assert.equal((await bot.actionsRulesAdmin('DELETE', boardRule.id, null)).status, 200);
  assert.equal((await exchange(await token({ run_attempt: '7' }), 'source')).status, 403);
  await mf.dispose(); mf = await workerRuntime({ directory, bindings, outboundService });
  const restarted = await mf.getDurableObjectNamespace('BOT', 'bot');
  const remaining = await restarted.get(restarted.idFromName('archive-v1')).actionsRulesAdmin('GET', null, null);
  assert.deepEqual(remaining.body.rules.map(r => r.name), ['Release site']);
});
