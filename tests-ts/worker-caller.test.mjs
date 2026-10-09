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
  await t.test('a valid certificate gets a token with issues and pull_requests write only', async () => {
    rsaClient = await register(admin, { name: 'RSA', certificate: rsa.certificate });
    assert.equal(rsaClient.operations, undefined);
    const result = await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), { repo: REPO });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['expires_at', 'repository', 'token']);
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

  await t.test('without the organization approving the write permissions the exchange is 503 and unrecorded', async () => {
    const before = (await grants(admin)).grants.length;
    state.approved = false;
    const result = await exchange(mf, await jwt(rsaClient, rsa.privateKey, 'RS256'), { repo: REPO });
    state.approved = true;
    assert.equal(result.status, 503);
    assert.equal((await grants(admin)).grants.length, before, 'refused exchanges are not recorded');
  });

  await t.test('sixty calls a minute per client, then 429', async () => {
    const pair = makeCertificate(), client = await register(admin, { name: 'Busy', certificate: pair.certificate });
    const statuses = [];
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
