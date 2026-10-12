import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { workerRuntime } from '../tools/worker-runtime.mjs';

const secret = 'isolated-worker-adapter-secret';
const sources = ['openJiuwen-ai/sciencediscovery', 'ScienceDiscovery/sciencediscovery'];
const destinations = ['ScienceDiscovery/github-status-board', 'ScienceDiscovery/github-status-board-test'];
const issue = repo => ({ action: 'opened', repository: { full_name: repo }, issue: { number: 42, title: 'A new issue', body: '<script>untrusted</script>' } });
const signed = (payload, delivery = randomUUID(), event = 'issues', provider = 'github') => {
  const body = JSON.stringify(payload);
  return { method: 'POST', body, headers: { 'content-type': 'application/json', [`x-${provider}-event`]: event,
    [`x-${provider}-delivery`]: delivery, [provider === 'github' ? 'x-hub-signature-256' : 'x-gitcode-signature-256']: 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } };
};
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  assert.fail('observable condition did not become true');
}

test('production Worker: durable history, isolated admin, recovery and Actions outbox', { timeout: 75000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-adapter-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dispatches = [], requests = [];
  let rejectTestDispatch = true;
  const outboundService = async request => {
    const path = new URL(request.url).pathname;
    requests.push(request.url);
    assert.equal(new URL(request.url).origin, 'https://api.github.com');
    if (path.endsWith('/installation') || path === '/app/installations/123/access_tokens') {
      const [header, payload, signature] = request.headers.get('authorization').slice(7).split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    }
    if (path.endsWith('/installation')) {
      assert.ok(destinations.some(repo => path === `/repos/${repo}/installation`));
      return Response.json({ id: 123 });
    }
    if (path === '/app/installations/123/access_tokens') {
      const data = await request.json();
      assert.deepEqual(data.permissions, { metadata: 'read', actions: 'write' });
      assert.equal(data.repositories.length, 1);
      return Response.json({ token: 'ephemeral-test-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    if (path.endsWith('/actions/workflows/collect.yml/dispatches')) {
      const data = await request.json();
      assert.equal(request.headers.get('authorization'), 'Bearer ephemeral-test-installation-token');
      assert.equal(data.ref, 'main');
      const index = sources.indexOf(data.inputs.source_repository);
      assert.ok(index >= 0); assert.ok(path.includes(destinations[index] + '/'));
      dispatches.push({ path, ...data });
      if (index === 1 && rejectTestDispatch) return new Response('private upstream body must not leak', { status: 503 });
      return new Response(null, { status: 204 });
    }
    throw new Error('unexpected outbound request');
  };
  const bindings = { SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_ADMIN_TOKEN: 'local-test-admin',
    SDBOT_GITHUB_APP_ID: 'test-app', SDBOT_GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    SDBOT_BOARD_TARGETS: JSON.stringify(Object.fromEntries(sources.map((source, i) => [source, destinations[i]]))), SDBOT_BOARD_DEBOUNCE: '2', SDBOT_BOARD_REFRESH: '3600' };
  let mf = await workerRuntime({ directory, bindings, outboundService });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  let admin = await mf.getWorker('admin');
  const auth = { authorization: 'Bearer local-test-admin' };
  const get = async path => { const response = await admin.fetch('http://localhost' + path, { headers: auth }); assert.equal(response.status, 200); return response.json(); };
  let firstRecord;
  const delivery = 'worker-persistent-delivery';
  await t.test('public surface and local-only management cannot be bypassed by a path or header', async () => {
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/healthz')).json(), { ok: true });
    for (const path of ['/api/status', '/api/events', '/api/listeners', '/_test/events', '/']) {
      const response = await mf.dispatchFetch('http://localhost' + path, { headers: { 'x-admin': 'true', ...auth } });
      assert.equal(response.status, 404); assert.deepEqual(await response.json(), { ok: false, error: 'not found' });
    }
    assert.equal((await mf.dispatchFetch('http://localhost/admin')).status, 503);
    assert.equal((await admin.fetch('http://localhost/api/status')).status, 401);
    assert.equal((await admin.fetch('http://localhost/api/status', { headers: { ...auth, 'cf-ray': 'test' } })).status, 403);
    assert.equal((await admin.fetch('http://public.example/api/status', { headers: auth })).status, 403);
    assert.match(await (await admin.fetch('http://localhost/')).text(), /Webhook/);
    assert.equal((await get('/api/listeners')).listeners.length, 11);
  });
  await t.test('store exact exchanges; concurrent duplicates request only one refresh', async () => {
    const options = signed(issue(sources[0]), delivery);
    options.headers.cookie = 'sensitive-cookie';
    const responses = await Promise.all(Array.from({ length: 6 }, () => mf.dispatchFetch('http://localhost/webhook/github?token=private-query', options)));
    for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, delivery_id: delivery }); }
    const events = (await get('/api/events?delivery_id=' + delivery)).events;
    assert.equal(events.length, 6); assert.equal(events.filter(e => e.duplicate).length, 5);
    firstRecord = events.find(e => !e.duplicate);
    const detail = await get('/api/events/' + firstRecord.record_id);
    assert.equal(detail.request.body, options.body);
    assert.equal(detail.request.headers.cookie, '[REDACTED]');
    assert.ok(!JSON.stringify(detail.request).includes('private-query'));
    assert.deepEqual(JSON.parse(detail.response.body), { ok: true, delivery_id: delivery });
    assert.deepEqual(firstRecord.hooks, ['analyze.on_issue', 'board.on_issue']);
    assert.equal((await get('/api/status')).board.targets[0].requested, 1);
  });
  await t.test('bad signature, unknown route/event and untracked repo are also archived', async () => {
    const bad = signed(issue(sources[0])); bad.headers['x-hub-signature-256'] = 'sha256=wrong';
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', bad)).status, 401);
    const missing = signed(issue(sources[0])); delete missing.headers['x-hub-signature-256'];
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', missing)).status, 401);
    assert.equal((await mf.dispatchFetch('http://localhost/not-webhook', signed(issue(sources[0])))).status, 404);
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', signed(issue('other/repo')))).status, 200);
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', signed(issue(sources[0]), randomUUID(), 'unknown_kind'))).status, 200);
    // A provider without a configured secret must never silently become unsigned.
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/gitcode', signed({}, randomUUID(), 'Issue Hook', 'gitcode'))).status, 401);
    const status = await get('/api/status');
    assert.equal(status.counts.ignored, 1); assert.equal(status.counts.rejected, 4);
    assert.equal(status.board.targets[0].requested, 1);
    assert.equal((await get('/api/events?status=rejected')).count, 4);
    const one = await get('/api/events?limit=1&offset=1'); assert.equal(one.count, 1); assert.equal(one.has_more, true);
  });
  await t.test('state survives runtime restart and removed replay cannot mutate it', async () => {
    await mf.dispose();
    mf = await workerRuntime({ directory, bindings, outboundService }); admin = await mf.getWorker('admin');
    assert.equal((await get('/api/events/' + firstRecord.record_id)).request.body, JSON.stringify(issue(sources[0])));
    await mf.dispatchFetch('http://localhost/webhook/github', signed(issue(sources[0]), delivery));
    assert.equal((await get('/api/events?limit=1')).events[0].duplicate, true);
    assert.equal((await get('/api/status')).board.targets[0].requested, 1);
    const before = (await get('/api/status')).counts;
    const replayPath = 'http://localhost/api/replay/' + firstRecord.record_id;
    assert.equal((await admin.fetch(replayPath, { method: 'POST', headers: auth })).status, 404);
    assert.equal((await admin.fetch(replayPath, { method: 'POST', headers: { ...auth, 'x-requested-with': 'sciencediscovery-bot' } })).status, 404);
    assert.deepEqual((await get('/api/status')).counts, before);
    await mf.dispatchFetch('http://localhost/webhook/github', signed(issue(sources[1])));
  });
  await t.test('durable alarms dispatch separate targets; failure retries without losing history', async () => {
    try { await until(() => dispatches.some(d => d.inputs.source_repository === sources[0]) && dispatches.some(d => d.inputs.source_repository === sources[1])); }
    catch (error) { assert.fail(JSON.stringify({ requests, board: (await get('/api/status')).board, cause: error.message })); }
    await until(async () => (await get('/api/status')).board.targets[1].error === 'Error');
    const status = await get('/api/status');
    assert.equal(status.board.targets[0].execution, 'github_actions');
    assert.equal(status.board.targets[0].commit, null); assert.equal(status.board.targets[0].last_success, null);
    assert.ok(status.board.targets[0].last_dispatch);
    assert.equal(status.board.targets[1].pending, true);
    assert.equal(JSON.stringify(status).includes('private upstream body'), false);
    rejectTestDispatch = false;
    await mf.dispose();
    mf = await workerRuntime({ directory, bindings, outboundService }); admin = await mf.getWorker('admin');
    await until(async () => !(await get('/api/status')).board.targets[1].pending, 40000);
    const final = (await get('/api/status')).board.targets[1];
    assert.equal(final.error, null); assert.equal(final.dispatched, final.requested);
    assert.equal(dispatches.filter(d => d.inputs.source_repository === sources[1]).length, 2);
    assert.equal((await get('/api/events/' + firstRecord.record_id)).response.status, 200);
    assert.ok(requests.every(path => !path.includes('/git/') && !path.includes('/issues')));
  });
});

test('failed R2 write commits neither dedupe nor business outbox; retry can be accepted', async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-failure-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-storage-failure.mjs', bindings: {
    SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_GITHUB_APP_ID: 'test-app', SDBOT_GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    SDBOT_BOARD_TARGETS: JSON.stringify({ [sources[0]]: destinations[0] }), SDBOT_BOARD_DEBOUNCE: '60',
  } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = await mf.getWorker('admin');
  const status = async () => (await admin.fetch('http://localhost/api/status')).json();
  const options = signed(issue(sources[0]), 'retry-storage-failure');
  const rejected = await mf.dispatchFetch('http://localhost/webhook/github', options);
  assert.equal(rejected.status, 503); assert.equal((await status()).counts.accepted, 0);
  assert.equal((await status()).board.targets[0].requested, 0);
  const accepted = await mf.dispatchFetch('http://localhost/webhook/github', options);
  assert.equal(accepted.status, 200);
  const state = await status();
  assert.equal(state.counts.accepted, 1); assert.equal(state.counts.duplicate, 0);
  assert.equal(state.board.targets[0].requested, 1);
});

test('large prefixes and non-UTF8 bytes remain inspectable and incomplete bodies cannot replay', async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-bodies-'));
  const mf = await workerRuntime({ directory, bindings: { SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_MAX_BODY_MB: '1' } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = await mf.getWorker('admin');
  const oversized = await mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { 'x-github-event': 'issues' } });
  assert.equal(oversized.status, 413);
  let record = (await (await admin.fetch('http://localhost/api/events?limit=1')).json()).events[0];
  assert.equal(record.body_complete, false); assert.equal(record.payload_bytes, 1024 * 1024);
  assert.equal((await admin.fetch('http://localhost/api/replay/' + record.record_id, { method: 'POST', headers: { 'x-requested-with': 'sciencediscovery-bot' } })).status, 404);
  const bytes = Buffer.from([255, 0, 127]);
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', body: bytes, headers: { 'x-github-event': 'issues' } })).status, 401);
  record = (await (await admin.fetch('http://localhost/api/events?limit=1')).json()).events[0];
  const detail = await (await admin.fetch('http://localhost/api/events/' + record.record_id)).json();
  assert.equal(detail.request.body_encoding, 'base64'); assert.equal(detail.request.body, bytes.toString('base64'));
});
