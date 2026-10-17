import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { accessFixture } from './support/access.mjs';
import { makeCertificate } from './support/certificates.mjs';

const REPO = 'openJiuwen-ai/sciencediscovery', OTHER = 'ScienceDiscovery/sciencediscovery';
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const EXPIRES = new Date(Date.now() + 3600000).toISOString();

async function runtime(t, bindings, options = {}) {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-caller-'));
  const access = await accessFixture();
  const calls = [], state = { approved: true };
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-rows.mjs', bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: 'caller-webhook-secret',
    SDBOT_REPOS: `${REPO},${OTHER}`, SDBOT_GITHUB_APP_ID: '123', SDBOT_GITHUB_APP_PRIVATE_KEY: appKey, ...bindings },
  outboundService: async request => {
    const jwks = access.jwks(request); if (jwks) return jwks;
    const url = new URL(request.url), text = await request.text();
    calls.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null });
    if (url.hostname !== 'api.github.com') return new Response(null, { status: 503 });
    if (url.pathname.endsWith('/installation')) return Response.json({ id: 42 });
    // Rule repositories: readable only when GitHub knows them.
    if (request.method === 'GET' && url.pathname.toLowerCase() === '/repos/openjiuwen-ai/tools') return Response.json({ id: 700, full_name: 'openJiuwen-ai/tools', owner: { id: 701 } });
    // Until the organization approves issues and pull_requests write, GitHub refuses the token.
    if (url.pathname === '/app/installations/42/access_tokens') return state.approved
      ? Response.json({ token: 'ghs_installation-token-' + calls.length, expires_at: EXPIRES }, { status: 201 })
      : Response.json({ message: 'The permissions requested are not granted to this installation.' }, { status: 422 });
    return new Response(null, { status: 404 });
  }, ...options });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = async (path, options) => { const response = await access.admin(mf, path, options); return { status: response.status, body: await response.json() }; };
  return { mf, calls, admin, state };
}
const register = async (admin, fields) => {
  const result = await admin('/admin/api/callers', { method: 'POST', body: { name: 'caller', repos: [], ...fields } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.client;
};
const jwt = (client, key, alg, claims = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti: randomUUID(), ...claims }).setProtectedHeader({ alg }).setIssuer(claims.iss ?? client.id).setSubject(claims.sub ?? client.id)
    .setAudience(claims.aud ?? 'sdbot:caller').setIssuedAt(claims.iat ?? now).setExpirationTime(claims.exp ?? now + 120).sign(key);
};
const exchange = async (mf, token, body, path = 'token') => {
  const response = await mf.dispatchFetch('http://localhost/caller/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const grants = async admin => (await admin('/admin/api/token-grants')).body;

test('certificate callers exchange a JWT for a narrowly scoped GitHub installation token', { timeout: 120000 }, async t => {
  const { mf, calls, admin, state } = await runtime(t, {});
  const rsa = makeCertificate({ type: 'rsa', cn: 'rsa caller' }), ec = makeCertificate({ type: 'ec', cn: 'ec caller' });

  await t.test('only public certificates are stored', async () => {
    for (const certificate of [rsa.certificate + rsa.privateKeyPem, rsa.privateKeyPem, rsa.certificate + ec.certificate, 'not a certificate', '']) {
      assert.equal((await admin('/admin/api/callers', { method: 'POST', body: { name: 'bad', certificate } })).status, 422, certificate.slice(0, 40));
    }
  });

  let rsaClient, ecClient;
  await t.test('a client saved without a choice gets a token with issues and pull_requests write only', async () => {
    rsaClient = await register(admin, { name: 'RSA', certificate: rsa.certificate });
    assert.equal(rsaClient.operations, undefined);
    assert.deepEqual(rsaClient.permissions, { metadata: 'read', issues: 'write', pull_requests: 'write' });
    const result = await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), { repo: REPO });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['expires_at', 'permissions', 'repository', 'token']);
    assert.deepEqual(result.body.permissions, { metadata: 'read', issues: 'write', pull_requests: 'write' });
    assert.deepEqual([result.body.expires_at, result.body.repository], [EXPIRES, REPO]);
    assert.match(result.body.token, /^ghs_installation-token-/);
    const grant = calls.find(c => c.url.endsWith('/app/installations/42/access_tokens'));
    assert.deepEqual(grant.body, { repositories: ['sciencediscovery'], permissions: { metadata: 'read', issues: 'write', pull_requests: 'write' } });
    assert.equal(calls.filter(c => !c.url.includes('/installation')).length, 0, 'the bot itself makes no other GitHub call');
  });

  await t.test('the issued token is recorded without the token string', async () => {
    const list = await grants(admin);
    assert.deepEqual([list.retention_days, list.limit], [60, 1000]);
    const [record] = list.grants;
    assert.deepEqual({ ...record, issued_at: undefined }, { issued_at: undefined, expires_at: EXPIRES, source: 'caller', identity: rsaClient.id, repository: REPO,
      purpose: null, permissions: 'metadata:read, issues:write, pull_requests:write' });
    assert.doesNotMatch(JSON.stringify(list), /ghs_|installation-token/);
    assert.doesNotMatch(JSON.stringify((await admin('/admin/api/callers')).body), /ghs_|installation-token/);
  });

  await t.test('the on-behalf paths are gone', async () => {
    for (const path of ['comments', 'labels', 'state', 'other'])
      assert.equal((await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, body: 'x' }, path)).status, 404, path);
  });

  await t.test('bad tokens are 401: wrong key, replay, claims, algorithm, lifetime, certificate validity', async () => {
    const token = await jwt(rsaClient, rsa.privateKey, 'RS256');
    assert.equal((await exchange(mf, token, { repo: REPO })).status, 200);
    assert.equal((await exchange(mf, token, { repo: REPO })).status, 401, 'replayed jti');
    const other = makeCertificate({ type: 'rsa' }), now = Math.floor(Date.now() / 1000);
    for (const [label, bad] of [
      ['other key', await jwt(rsaClient, other.privateKey, 'RS256')],
      ['audience', await jwt(rsaClient, rsa.privateKey, 'RS256', { aud: 'someone-else' })],
      ['subject', await jwt(rsaClient, rsa.privateKey, 'RS256', { sub: 'not-the-client' })],
      ['unknown client', await jwt({ id: randomUUID() }, rsa.privateKey, 'RS256')],
      ['expired', await jwt(rsaClient, rsa.privateKey, 'RS256', { iat: now - 900, exp: now - 600 })],
      ['too long-lived', await jwt(rsaClient, rsa.privateKey, 'RS256', { exp: now + 3600 })],
      ['missing jti', await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(rsaClient.id).setSubject(rsaClient.id).setAudience('sdbot:caller').setIssuedAt().setExpirationTime('2m').sign(rsa.privateKey)],
      ['no token', ''],
    ]) assert.equal((await exchange(mf, bad, { repo: REPO })).status, 401, label);
    const day = 86400000;
    for (const window of [{ notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() - day) }, { notBefore: new Date(Date.now() + day), notAfter: new Date(Date.now() + 30 * day) }]) {
      const pair = makeCertificate(window), client = await register(admin, { name: 'out of date', certificate: pair.certificate });
      const result = await exchange(mf, await jwt(client, pair.privateKey, 'RS256'), { repo: REPO });
      assert.deepEqual([result.status, result.body.error], [401, 'certificate is not within its validity period']);
    }
  });

  await t.test('repositories outside SDBOT_REPOS or the client list are 403; bad bodies 422', async () => {
    ecClient = await register(admin, { name: 'EC', certificate: ec.certificate, repos: [OTHER] });
    assert.equal(ecClient.alg, 'ES256');
    assert.deepEqual((await exchange(mf, await jwt(ecClient, ec.privateKey, 'ES256'), { repo: OTHER })).status, 200);
    assert.equal((await exchange(mf, await jwt(ecClient, ec.privateKey, 'ES256'), { repo: REPO })).status, 403, 'not in the client list');
    assert.equal((await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), { repo: 'someone/else' })).status, 403, 'not in SDBOT_REPOS');
    for (const body of [{ repo: REPO, provider: 'gitcode' }, { provider: 'gitcode', repo: 'openJiuwen/sciencediscovery' }, { repo: 'no-slash' }, {}, [REPO], 'not json'])
      assert.equal((await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), body)).status, 422, JSON.stringify(body));
    assert.equal(calls.filter(c => c.url.includes('gitcode')).length, 0);
  });

  await t.test('the permissions chosen for a client decide its token, and can be changed later', async () => {
    const pair = makeCertificate(), list = (await admin('/admin/api/callers')).body;
    assert.deepEqual(list.permission_catalog.map(p => p.key), ['metadata', 'contents', 'issues', 'pull_requests', 'actions', 'checks', 'statuses', 'workflows', 'merge_queues', 'deployments', 'pages', 'discussions']);
    assert.deepEqual(list.permission_catalog.find(p => p.key === 'workflows').levels, ['write']);
    assert.ok(list.permission_catalog.every(p => p.label && p.description.length > 30));
    assert.deepEqual(list.default_permissions, { metadata: 'read', issues: 'write', pull_requests: 'write' });
    // "none" drops a permission; metadata stays read whatever is sent.
    const client = await register(admin, { name: 'Reader', certificate: pair.certificate,
      permissions: { metadata: 'none', contents: 'read', issues: 'none', pull_requests: 'write', checks: 'write', workflows: 'none' } });
    assert.deepEqual(client.permissions, { metadata: 'read', contents: 'read', pull_requests: 'write', checks: 'write' });
    const before = calls.length, result = await exchange(mf, await jwt(client, pair.privateKey, 'RS256'), { repo: REPO });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.permissions, client.permissions);
    assert.deepEqual(calls.slice(before).find(c => c.url.endsWith('/access_tokens')).body.permissions, { metadata: 'read', contents: 'read', pull_requests: 'write', checks: 'write' });
    assert.equal((await grants(admin)).grants[0].permissions, 'metadata:read, contents:read, pull_requests:write, checks:write');
    // An update without permissions keeps them; one with permissions replaces them.
    const kept = await admin('/admin/api/callers/' + client.id, { method: 'PUT', body: { name: 'Reader 2', certificate: pair.certificate } });
    assert.deepEqual([kept.status, kept.body.client.name, kept.body.client.permissions], [200, 'Reader 2', client.permissions]);
    const changed = await admin('/admin/api/callers/' + client.id, { method: 'PUT', body: { name: 'Reader 2', certificate: pair.certificate, permissions: { issues: 'read', workflows: 'write', contents: 'write' } } });
    assert.deepEqual(changed.body.client.permissions, { metadata: 'read', contents: 'write', issues: 'read', workflows: 'write' });
    for (const [permissions, error] of [
      [{ administration: 'write' }, /unknown permission administration/], [{ workflows: 'read' }, /workflows can only be write, none/],
      [{ issues: 'admin' }, /issues can only be read, write, none/], [{ metadata: 'read' }, /at least one permission besides metadata/],
      [{ issues: 'none' }, /at least one permission besides metadata/], [['issues'], /must be an object/], ['write', /must be an object/],
    ]) {
      const refused = await admin('/admin/api/callers', { method: 'POST', body: { name: 'bad', certificate: makeCertificate().certificate, permissions } });
      assert.equal(refused.status, 422, JSON.stringify(permissions));
      assert.match(refused.body.error, error);
    }
  });

  await t.test('without the organization approving the chosen permissions the exchange is 503 and unrecorded', async () => {
    const before = (await grants(admin)).grants.length;
    state.approved = false;
    const result = await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), { repo: REPO });
    state.approved = true;
    assert.equal(result.status, 503);
    assert.match(result.body.error, /metadata:read, issues:write, pull_requests:write/);
    assert.equal((await grants(admin)).grants.length, before, 'refused exchanges are not recorded');
  });

  await t.test('sixty calls a minute per client, then 429', async () => {
    const pair = makeCertificate(), client = await register(admin, { name: 'Busy', certificate: pair.certificate });
    const statuses = [];
    // The limit counts per calendar minute, so the 61 calls must not straddle a minute boundary.
    const left = 60000 - Date.now() % 60000;
    if (left < 10000) await new Promise(r => setTimeout(r, left + 100));
    for (let i = 0; i < 61; i++) statuses.push((await exchange(mf, await jwt(client, pair.privateKey, 'RS256'), { repo: REPO })).status);
    assert.deepEqual([statuses.slice(0, 60).every(s => s === 200), statuses[60]], [true, 429]);
  });

  await t.test('the exchange is not a webhook and the token list is read-only', async () => {
    assert.equal((await admin('/admin/api/events')).body.count, 0, 'caller requests are not archived as webhooks');
    assert.equal((await mf.dispatchFetch('http://localhost/caller/v1/token')).status, 405);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await admin('/admin/api/token-grants', { method, body: {} })).status, 405);
    assert.equal((await mf.dispatchFetch('http://localhost/admin/api/token-grants')).status, 401);
  });
});

test('token records keep 60 days and at most 1000 entries, pruned on insert and by the cron', { timeout: 60000 }, async t => {
  const { mf } = await runtime(t, {});
  const rpc = async (path, params = {}) => (await mf.dispatchFetch(`http://localhost/_test/${path}?` + new URLSearchParams(params))).json();
  const day = 86400000, now = Date.now();
  // Two records issued 59 days ago: kept on insert, dropped by the cron two days later.
  await rpc('seed-grants', { count: 2, issued: now - 59 * day, prefix: 'old' });
  assert.equal((await rpc('grant-count')).count, 2);
  // The five-minute cron runs the same pruning, so old records go even when nothing new is issued.
  await (await mf.getWorker()).scheduled({ scheduledTime: new Date(now + 2 * day) });
  assert.equal((await rpc('grant-count')).count, 0);
  // 1005 fresh records: the five oldest give way to the newest 1000.
  await rpc('seed-grants', { count: 1005, issued: now, prefix: 'fresh' });
  const after = await rpc('grant-count');
  assert.deepEqual([after.count, after.oldest], [1000, 'fresh-5']);
});

test('clients saved before permissions were configurable keep issues and pull_requests write', { timeout: 60000 }, async t => {
  const { mf, calls, admin } = await runtime(t, {});
  const pair = makeCertificate(), client = await register(admin, { name: 'Legacy', certificate: pair.certificate, permissions: { contents: 'write' } });
  await mf.dispatchFetch('http://localhost/_test/legacy-callers');
  const listed = (await admin('/admin/api/callers')).body.clients.find(c => c.id === client.id);
  assert.deepEqual(listed.permissions, { metadata: 'read', issues: 'write', pull_requests: 'write' });
  assert.equal((await exchange(mf, await jwt(client, pair.privateKey, 'RS256'), { repo: REPO })).status, 200);
  assert.deepEqual(calls.find(c => c.url.endsWith('/access_tokens')).body.permissions, { metadata: 'read', issues: 'write', pull_requests: 'write' });
});

test('GitHub Actions access rules are managed behind Access, starting from the dashboard collection', { timeout: 60000 }, async t => {
  const BOARD = 'ScienceDiscovery/github-status-board';
  const boardBindings = { SDBOT_BOARD_TARGETS: JSON.stringify({ [REPO]: BOARD }), SDBOT_ACTIONS_REPOSITORY_ID: '200', SDBOT_ACTIONS_OWNER_ID: '100' };
  const { mf, admin, calls } = await runtime(t, boardBindings);
  // Permissions saved on the earlier single Actions entry carry over into the seeded rule.
  await mf.dispatchFetch('http://localhost/_test/legacy-actions-permissions?' + new URLSearchParams({ doc: JSON.stringify({ source: { metadata: 'read', contents: 'read', actions: 'read' }, target: { metadata: 'read', contents: 'write' } }) }));
  const shown = await admin('/admin/api/actions-rules');
  assert.equal(shown.status, 200);
  assert.deepEqual([shown.body.limit, shown.body.grant_limit, shown.body.permission_catalog.length], [20, 10, 12]);
  assert.deepEqual(shown.body.events.map(e => e.key), ['schedule', 'workflow_dispatch', 'push', 'release', 'workflow_run', 'repository_dispatch']);
  const [board] = shown.body.rules;
  assert.deepEqual({ ...board, id: undefined, created: undefined, updated: undefined }, { id: undefined, created: undefined, updated: undefined, name: '看板采集',
    repository: BOARD, repository_id: '200', owner_id: '100', workflow: '.github/workflows/collect.yml', branch: 'main', events: ['schedule', 'workflow_dispatch'],
    grants: [{ purpose: 'source', repository: REPO, permissions: { metadata: 'read', contents: 'read', actions: 'read' } }, { purpose: 'target', repository: BOARD, permissions: { metadata: 'read', contents: 'write' } }] });

  const rule = { name: 'Release', repository: 'openjiuwen-ai/tools', workflow: '.github/workflows/release.yml', branch: 'release', events: ['push', 'push', 'schedule'],
    grants: [{ purpose: 'publish', repository: OTHER, permissions: { contents: 'write', workflows: 'none' } }, { purpose: 'notes', repository: REPO, permissions: { issues: 'write' } }] };
  const created = await admin('/admin/api/actions-rules', { method: 'POST', body: rule });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // The repository is pinned by the IDs GitHub reports, under the name GitHub uses.
  assert.deepEqual([created.body.rule.repository, created.body.rule.repository_id, created.body.rule.owner_id, created.body.rule.events], ['openJiuwen-ai/tools', '700', '701', ['schedule', 'push']]);
  assert.ok(calls.some(c => c.method === 'GET' && c.url.endsWith('/repos/openjiuwen-ai/tools')));
  const id = created.body.rule.id;
  // Keeping the repository keeps its IDs without asking GitHub again; another repository is looked up.
  const lookups = () => calls.filter(c => c.method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(c.url)).length, before = lookups();
  assert.equal((await admin('/admin/api/actions-rules/' + id, { method: 'PUT', body: { ...rule, name: 'Release 2', repository: 'openJiuwen-ai/tools' } })).body.rule.repository_id, '700');
  assert.equal(lookups(), before);
  const missing = await admin('/admin/api/actions-rules/' + id, { method: 'PUT', body: { ...rule, repository: 'nobody/nothing' } });
  assert.deepEqual([missing.status, /cannot read nobody\/nothing/.test(missing.body.error)], [422, true]);
  for (const [change, error] of [
    [{ name: '' }, /name/], [{ repository: 'no-slash' }, /owner\/name/], [{ workflow: 'collect.yml' }, /\.github\/workflows/], [{ workflow: '.github/workflows/../x.yml' }, /\.github\/workflows/],
    [{ branch: 'refs/heads/main' }, /branch/], [{ events: ['pull_request_target'] }, /events must be/], [{ events: [] }, /events must be/],
    [{ grants: [] }, /1-10 tokens/], [{ grants: [{ purpose: 'Bad', repository: REPO, permissions: { issues: 'read' } }] }, /purpose/],
    [{ grants: [{ purpose: 'a', repository: REPO, permissions: { issues: 'read' } }, { purpose: 'a', repository: OTHER, permissions: { issues: 'read' } }] }, /used twice/],
    [{ grants: [{ purpose: 'a', repository: REPO, permissions: { secrets: 'read' } }] }, /token a: unknown permission secrets/],
  ]) {
    const refused = await admin('/admin/api/actions-rules', { method: 'POST', body: { ...rule, ...change } });
    assert.deepEqual([refused.status, error.test(refused.body.error)], [422, true], JSON.stringify(change) + ' ' + refused.body.error);
  }
  for (const method of ['PATCH', 'PUT']) assert.equal((await admin('/admin/api/actions-rules', { method, body: rule })).status, 405, method);
  assert.equal((await admin('/admin/api/actions-rules', { method: 'POST', body: rule, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await admin('/admin/api/actions-rules', { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await mf.dispatchFetch('http://localhost/admin/api/actions-rules')).status, 401);
  assert.equal((await mf.dispatchFetch('http://localhost/admin/api/actions-rules', { method: 'POST', body: JSON.stringify(rule), headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await admin('/admin/api/actions-permissions')).status, 404, 'the single entry it replaces is gone');
  assert.equal((await admin('/admin/api/actions-rules/' + id, { method: 'DELETE' })).status, 200);
  assert.equal((await admin('/admin/api/actions-rules/' + id, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await admin('/admin/api/actions-rules')).body.rules.map(r => r.name), ['看板采集']);
});
