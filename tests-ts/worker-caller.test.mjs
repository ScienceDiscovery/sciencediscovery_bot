import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { accessFixture } from './support/access.mjs';
import { makeCertificate } from './support/certificates.mjs';

const REPO = 'openJiuwen-ai/sciencediscovery', GITCODE = 'openJiuwen/sciencediscovery';
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

async function runtime(t, bindings, upstream = () => null) {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-caller-'));
  const access = await accessFixture();
  const calls = [];
  const mf = await workerRuntime({ directory, bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: 'caller-webhook-secret', SDBOT_REPOS: REPO, ...bindings },
    outboundService: async request => {
      const jwks = access.jwks(request); if (jwks) return jwks;
      const text = await request.text();
      calls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: text ? JSON.parse(text) : null });
      return upstream(request, calls.at(-1)) || new Response(null, { status: 404 });
    } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = async (path, options) => { const response = await access.admin(mf, path, options); return { status: response.status, body: await response.json() }; };
  return { mf, calls, admin };
}
const register = async (admin, fields) => {
  const result = await admin('/admin/api/callers', { method: 'POST', body: { name: 'caller', operations: ['comment', 'labels', 'state'], repos: [], ...fields } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.client;
};
const jwt = (client, key, alg, claims = {}, header = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ jti: randomUUID(), ...claims }).setProtectedHeader({ alg, ...header }).setIssuer(claims.iss ?? client.id).setSubject(claims.sub ?? client.id)
    .setAudience(claims.aud ?? 'sdbot:caller').setIssuedAt(claims.iat ?? now).setExpirationTime(claims.exp ?? now + 120).sign(key);
};
const call = async (mf, path, token, body) => {
  const response = await mf.dispatchFetch('http://localhost/caller/v1/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

const github = (request, call) => {
  const url = new URL(request.url);
  if (url.hostname !== 'api.github.com') return null;
  if (url.pathname === `/repos/${REPO}/installation`) return Response.json({ id: 42 });
  if (url.pathname === '/app/installations/42/access_tokens') return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() }, { status: 201 });
  if (url.pathname === `/repos/${REPO}/issues/7/comments`) return Response.json({ id: 1 }, { status: 201 });
  if (url.pathname === `/repos/${REPO}/issues/7/labels`) return Response.json([]);
  if (url.pathname.startsWith(`/repos/${REPO}/issues/7/labels/`)) return new Response(null, { status: url.pathname.endsWith('/absent') ? 404 : 200 });
  if (url.pathname === `/repos/${REPO}/issues/7` && call.method === 'PATCH') return Response.json({ number: 7, state: call.body.state });
  return null;
};
const gitcode = (request, call) => {
  const url = new URL(request.url);
  if (url.hostname !== 'api.gitcode.com') return null;
  if (url.pathname === `/api/v5/repos/${GITCODE}/pulls/5/comments`) return Response.json({ id: 9 }, { status: 201 });
  if (url.pathname === `/api/v5/repos/${GITCODE}/pulls/5` && call.method === 'PATCH') return Response.json({ number: 5, state: call.body.state, head: {}, base: {} });
  return null;
};

test('certificate callers act within their operations and repositories', { timeout: 120000 }, async t => {
  const { mf, calls, admin } = await runtime(t, { SDBOT_GITHUB_APP_ID: '123', SDBOT_GITHUB_APP_PRIVATE_KEY: appKey, GITCODE_TOKEN: 'gitcode-caller-token' },
    (request, call) => github(request, call) || gitcode(request, call));
  const rsa = makeCertificate({ type: 'rsa', cn: 'rsa caller' }), ec = makeCertificate({ type: 'ec', cn: 'ec caller' });

  await t.test('only public certificates are stored', async () => {
    for (const certificate of [rsa.certificate + rsa.privateKeyPem, rsa.privateKeyPem, rsa.certificate + ec.certificate, 'not a certificate', '']) {
      const result = await admin('/admin/api/callers', { method: 'POST', body: { name: 'bad', operations: ['comment'], certificate } });
      assert.equal(result.status, 422, certificate.slice(0, 40));
    }
    const leaked = await admin('/admin/api/callers', { method: 'POST', body: { name: 'bad', operations: ['comment'], certificate: rsa.certificate + rsa.privateKeyPem } });
    assert.match(leaked.body.error, /private key/);
  });

  let rsaClient, ecClient;
  await t.test('an RSA client comments and labels through a narrowly scoped installation token', async () => {
    rsaClient = await register(admin, { name: 'RSA', certificate: rsa.certificate, operations: ['comment', 'labels'] });
    assert.deepEqual([rsaClient.alg, rsaClient.subject], ['RS256', 'rsa caller']);
    const result = await call(mf, 'comments', await jwt(rsaClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, body: 'from a caller' });
    assert.deepEqual(result, { status: 200, body: { ok: true, operation: 'comment', upstream_status: 201 } });
    const grant = calls.find(c => c.url.endsWith('/app/installations/42/access_tokens'));
    assert.deepEqual(grant.body, { repositories: ['sciencediscovery'], permissions: { metadata: 'read', issues: 'write', pull_requests: 'write' } });
    const comment = calls.find(c => c.url.endsWith('/issues/7/comments'));
    assert.deepEqual([comment.method, comment.body, comment.headers.authorization], ['POST', { body: 'from a caller' }, 'Bearer installation-token']);
    const labels = await call(mf, 'labels', await jwt(rsaClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, add: ['bug'], remove: ['triage', 'absent'] });
    assert.deepEqual(labels.status, 200);
    assert.deepEqual(calls.filter(c => c.url.includes('/issues/7/labels')).map(c => `${c.method} ${new URL(c.url).pathname.split('/labels')[1]}`), ['POST ', 'DELETE /triage', 'DELETE /absent']);
  });

  await t.test('bad tokens are 401: wrong key, replay, claims, algorithm, lifetime', async () => {
    const token = await jwt(rsaClient, rsa.privateKey, 'RS256');
    const body = { provider: 'github', repo: REPO, number: 7, body: 'once' };
    assert.equal((await call(mf, 'comments', token, body)).status, 200);
    assert.equal((await call(mf, 'comments', token, body)).status, 401, 'replayed jti');
    const other = makeCertificate({ type: 'rsa' });
    for (const [label, bad] of [
      ['other key', await jwt(rsaClient, other.privateKey, 'RS256')],
      ['audience', await jwt(rsaClient, rsa.privateKey, 'RS256', { aud: 'someone-else' })],
      ['subject', await jwt(rsaClient, rsa.privateKey, 'RS256', { sub: 'not-the-client' })],
      ['unknown issuer', await jwt({ id: randomUUID() }, rsa.privateKey, 'RS256')],
      ['expired', await jwt(rsaClient, rsa.privateKey, 'RS256', { iat: Math.floor(Date.now() / 1000) - 900, exp: Math.floor(Date.now() / 1000) - 600 })],
      ['too long-lived', await jwt(rsaClient, rsa.privateKey, 'RS256', { exp: Math.floor(Date.now() / 1000) + 3600 })],
      ['missing jti', await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(rsaClient.id).setSubject(rsaClient.id).setAudience('sdbot:caller').setIssuedAt().setExpirationTime('2m').sign(rsa.privateKey)],
      ['HS256', await new SignJWT({ jti: randomUUID() }).setProtectedHeader({ alg: 'HS256' }).setIssuer(rsaClient.id).setSubject(rsaClient.id).setAudience('sdbot:caller').setIssuedAt().setExpirationTime('2m').sign(new TextEncoder().encode('x'.repeat(32)))],
      ['no token', ''],
    ]) assert.equal((await call(mf, 'comments', bad, body)).status, 401, label);
  });

  await t.test('an EC client may only change state, and only where allowed', async () => {
    ecClient = await register(admin, { name: 'EC', certificate: ec.certificate, operations: ['state'], repos: [REPO] });
    assert.equal(ecClient.alg, 'ES256');
    const closed = await call(mf, 'state', await jwt(ecClient, ec.privateKey, 'ES256'), { provider: 'github', repo: REPO, number: 7, state: 'closed' });
    assert.deepEqual(closed, { status: 200, body: { ok: true, operation: 'state', upstream_status: 200 } });
    assert.deepEqual(calls.filter(c => c.method === 'PATCH').at(-1).body, { state: 'closed' });
    // An RS256 token for an EC certificate is refused before anything else.
    assert.equal((await call(mf, 'state', await jwt(ecClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, state: 'open' })).status, 401);
    const forbidden = [
      ['comments', { provider: 'github', repo: REPO, number: 7, body: 'not allowed' }],
      ['state', { provider: 'github', repo: 'someone/else', number: 7, state: 'open' }],
      ['state', { provider: 'gitcode', repo: GITCODE, number: 5, state: 'open' }],
    ];
    for (const [path, body] of forbidden) assert.equal((await call(mf, path, await jwt(ecClient, ec.privateKey, 'ES256'), body)).status, 403, JSON.stringify(body));
    for (const body of [{ provider: 'github', repo: REPO, number: 0, state: 'open' }, { provider: 'github', repo: REPO, number: 7, state: 'merged' },
      { provider: 'gitlab', repo: REPO, number: 7, state: 'open' }, { provider: 'github', repo: 'no-slash', number: 7, state: 'open' }]) {
      assert.equal((await call(mf, 'state', await jwt(ecClient, ec.privateKey, 'ES256'), body)).status, 422, JSON.stringify(body));
    }
    assert.equal((await call(mf, 'labels', await jwt(rsaClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7 })).status, 422);
  });

  await t.test('GitCode writes use the sync target and token on merge requests', async () => {
    const pair = makeCertificate({ cn: 'gitcode caller' }), key = { pair, client: await register(admin, { name: 'GitCode', certificate: pair.certificate }) };
    const comment = await call(mf, 'comments', await jwt(key.client, key.pair.privateKey, 'RS256'), { provider: 'gitcode', repo: GITCODE, number: 5, body: 'mirror note' });
    assert.deepEqual(comment, { status: 200, body: { ok: true, operation: 'comment', upstream_status: 201 } });
    const sent = calls.find(c => c.url.includes('/pulls/5/comments'));
    assert.deepEqual([sent.method, sent.body, sent.headers['private-token']], ['POST', { body: 'mirror note' }, 'gitcode-caller-token']);
    assert.equal((await call(mf, 'comments', await jwt(key.client, key.pair.privateKey, 'RS256'), { provider: 'gitcode', repo: 'other/repo', number: 5, body: 'x' })).status, 403);
  });

  await t.test('certificates outside their validity period are refused', async () => {
    const day = 86400000;
    for (const [label, window] of [['expired', { notBefore: new Date(Date.now() - 30 * day), notAfter: new Date(Date.now() - day) }],
      ['not yet valid', { notBefore: new Date(Date.now() + day), notAfter: new Date(Date.now() + 30 * day) }]]) {
      const pair = makeCertificate(window);
      const client = await register(admin, { name: label, certificate: pair.certificate });
      const result = await call(mf, 'comments', await jwt(client, pair.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, body: 'x' });
      assert.deepEqual([result.status, result.body.error], [401, 'certificate is not within its validity period'], label);
    }
  });

  await t.test('sixty calls a minute per client, then 429', async () => {
    const pair = makeCertificate(), client = await register(admin, { name: 'Busy', certificate: pair.certificate, operations: ['comment'] });
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await call(mf, 'comments', await jwt(client, pair.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, body: 'n' + i })).status);
    assert.deepEqual([statuses.slice(0, 60).every(s => s === 200), statuses[60]], [true, 429]);
  });

  await t.test('the audit keeps who did what, never tokens or comment bodies; the path is not a webhook', async () => {
    // The page lists the latest 50 entries; make the newest two a success and a refusal.
    assert.equal((await call(mf, 'comments', await jwt(rsaClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, body: 'from a caller' })).status, 200);
    assert.equal((await call(mf, 'comments', await jwt(ecClient, ec.privateKey, 'ES256'), { provider: 'github', repo: REPO, number: 7, body: 'from a caller' })).status, 403);
    const list = await admin('/admin/api/callers');
    const [refused, done] = list.body.audit;
    assert.deepEqual(Object.keys(done).sort(), ['at', 'client', 'number', 'operation', 'provider', 'repo', 'result', 'upstream_status']);
    assert.deepEqual([done.client, done.operation, done.repo, done.number, done.upstream_status, done.result], [rsaClient.id, 'comment', REPO, 7, 201, 'ok']);
    assert.deepEqual([refused.client, refused.result, refused.upstream_status], [ecClient.id, 'forbidden', null]);
    assert.doesNotMatch(JSON.stringify(list.body.audit), /from a caller|mirror note|eyJ/);
    assert.equal((await admin('/admin/api/events')).body.count, 0, 'caller requests are not archived as webhooks');
    assert.equal((await mf.dispatchFetch('http://localhost/caller/v1/comments')).status, 405);
    assert.equal((await mf.dispatchFetch('http://localhost/caller/v1/merge', { method: 'POST' })).status, 404);
    assert.equal((await mf.dispatchFetch('http://localhost/healthz')).status, 200);
    assert.equal((await admin('/admin/api/callers/' + rsaClient.id, { method: 'DELETE' })).status, 200);
    assert.equal((await call(mf, 'comments', await jwt(rsaClient, rsa.privateKey, 'RS256'), { provider: 'github', repo: REPO, number: 7, body: 'gone' })).status, 401);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await admin('/admin/api/usage', { method })).status, 405);
  });
});

test('GitCode calls are refused clearly while GitCode sync is off', async t => {
  const { mf, admin } = await runtime(t, { SDBOT_GITCODE_SYNC_TARGET: 'off' });
  const pair = makeCertificate(), client = await register(admin, { name: 'GitCode off', certificate: pair.certificate });
  const result = await call(mf, 'comments', await jwt(client, pair.privateKey, 'RS256'), { provider: 'gitcode', repo: GITCODE, number: 5, body: 'x' });
  assert.deepEqual([result.status, result.body.error], [403, 'GitCode writes need active GitCode sync with a token (disabled: off)']);
});
