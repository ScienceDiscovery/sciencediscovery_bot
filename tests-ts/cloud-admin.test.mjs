import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { workerRuntime } from '../tools/worker-runtime.mjs';

test('cloud management validates Access and is read-only on the public Worker', async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/cloud-admin-'));
  const issuer = 'https://test-admin.cloudflareaccess.com', audience = 'isolated-audience';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'isolated-key', alg: 'RS256', use: 'sig' };
  let keyRequests = 0;
  const mf = await workerRuntime({ directory, bindings: {
    SDBOT_GITHUB_WEBHOOK_SECRET: 'isolated-secret', SDBOT_ACCESS_ISSUER: issuer, SDBOT_ACCESS_AUD: audience,
    SDBOT_ADMIN_HOSTNAME: 'localhost', SDBOT_ENVIRONMENT: 'test',
  }, outboundService: request => {
    assert.equal(request.url, issuer + '/cdn-cgi/access/certs'); keyRequests++;
    return Response.json({ keys: [key] });
  } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const token = (claims = {}, signingKey = privateKey) => new SignJWT({ sub: 'test-member', iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, iss: issuer, aud: audience, ...claims }).setProtectedHeader({ alg: 'RS256', kid: key.kid }).sign(signingKey);
  const auth = { 'cf-access-jwt-assertion': await token() };
  const get = async path => (await mf.dispatchFetch('http://localhost' + path, { headers: auth })).json();
  for (const path of ['/admin', '/admin/', '/admin/api/status', '/admin/api/events', '/admin/api/listeners', '/admin/api/events/missing']) {
    assert.equal((await mf.dispatchFetch('http://localhost' + path)).status, 401);
    assert.equal((await mf.dispatchFetch('http://localhost' + path, { headers: { 'cf-access-authenticated-user-email': 'admin@example.test', 'x-admin': '1', authorization: 'Bearer invented' } })).status, 401);
  }
  for (const claims of [{ exp: 1 }, { aud: 'other-app' }, { iss: 'https://evil.example' }, { sub: '' }, { exp: undefined }, { nbf: Math.floor(Date.now() / 1000) + 300 }]) {
    assert.equal((await mf.dispatchFetch('http://localhost/admin/api/status', { headers: { 'cf-access-jwt-assertion': await token(claims) } })).status, 401);
  }
  const wrongKey = await generateKeyPair('RS256');
  assert.equal((await mf.dispatchFetch('http://localhost/admin/api/status', { headers: { 'cf-access-jwt-assertion': await token({}, wrongKey.privateKey) } })).status, 401);
  assert.equal((await mf.dispatchFetch('http://other.example/admin', { headers: auth })).status, 401);
  assert.equal((await mf.dispatchFetch('http://localhost/admin', { headers: { 'cf-access-jwt-assertion': 'not-a-jwt' } })).status, 401);
  const shell = await mf.dispatchFetch('http://localhost/admin/', { headers: auth });
  assert.equal(shell.status, 200); assert.equal(shell.headers.get('cache-control'), 'no-store');
  const html = await shell.text(); assert.match(html, /Webhook 投递详情/); assert.doesNotMatch(html, /button\.replay|\/api\/replay/);
  for (const path of ['/api/status', '/api/events', '/api/listeners', '/api/replay/x', '/administrator/api/status', '/admin%2fapi/status']) {
    assert.equal((await mf.dispatchFetch('http://localhost' + path, { headers: auth })).status, 404);
  }
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'ScienceDiscovery/sciencediscovery' }, issue: { number: 3, title: '<script>never execute</script>' } });
  const signed = { method: 'POST', body, headers: { 'x-github-event': 'issues', 'x-github-delivery': 'cloud-admin-test',
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'isolated-secret').update(body).digest('hex'), cookie: 'private-cookie', 'cf-access-jwt-assertion': 'private-assertion' } };
  const response = await mf.dispatchFetch('http://localhost/webhook/github', signed); assert.equal(response.status, 200);
  const events = await get('/admin/api/events'); assert.equal(events.count, 1);
  const detail = await get('/admin/api/events/' + events.events[0].record_id);
  assert.equal(detail.request.body, body); assert.equal(detail.request.headers.cookie, '[REDACTED]');
  assert.equal(detail.request.headers['cf-access-jwt-assertion'], '[REDACTED]');
  assert.deepEqual(JSON.parse(detail.response.body), await response.json());
  assert.equal((await get('/admin/api/listeners')).listeners.length, 11);
  const before = await get('/admin/api/status');
  assert.equal(before.environment, 'test'); assert.equal(before.runtime, 'cloudflare');
  assert.equal(before.config.data_dir, undefined); assert.equal(before.config.webhook, undefined);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) for (const path of ['/admin/api/status', '/admin/api/replay/' + events.events[0].record_id]) {
    assert.equal((await mf.dispatchFetch('http://localhost' + path, { method, headers: auth })).status, 405);
  }
  assert.deepEqual((await get('/admin/api/status')).counts, before.counts);
  assert.equal((await get('/admin/api/events')).count, 1); assert.equal(keyRequests, 1);
});
