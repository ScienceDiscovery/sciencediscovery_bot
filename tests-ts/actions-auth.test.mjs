import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from 'jose';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';

const issuer = 'https://token.actions.githubusercontent.com';
test('OIDC exchange binds identity and scope, persists issuance guards and never archives credentials', async t => {
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
  assert.equal((await exchange(jwt, 'admin')).status, 400);
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
});
