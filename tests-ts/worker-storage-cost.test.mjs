import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';

// Durable Object SQLite is billed per row read and written; the free plan stops
// all storage calls once its daily allowance is spent. These bounds must not grow
// with the dedupe window or with the number of recent credential claims.
const secret = 'storage-cost-secret';
const repo = 'openJiuwen-ai/sciencediscovery';
const WINDOW = 40;
const signed = delivery => {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: repo }, issue: { number: 1, title: 'cost' } });
  return { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } };
};

test('hot paths read a bounded number of SQLite rows', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-cost-'));
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-rows.mjs', bindings: {
    SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_ADMIN_TOKEN: 'local-test-admin', SDBOT_DEDUPE_WINDOW: String(WINDOW) } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = await mf.getWorker('admin');
  const get = async path => (await admin.fetch('http://localhost' + path, { headers: { authorization: 'Bearer local-test-admin' } })).json();
  const rows = async () => (await mf.dispatchFetch('http://localhost/_test/rows')).json();
  const deliver = async id => assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', signed(id))).status, 200);

  await t.test('the dedupe window forgets exactly its oldest delivery and reads only that row', async () => {
    for (let i = 0; i < WINDOW + 20; i++) await deliver(`cost-${i}`);
    await rows();
    await deliver('cost-next');
    const cost = await rows();
    // The previous full-window trim read about twice the window on every delivery.
    assert.ok(cost.read <= 25, `rows read per delivery: ${cost.read}`);
    assert.ok(cost.written <= 25, `rows written per delivery: ${cost.written}`);
    assert.equal((await get('/api/status')).remembered_deliveries, WINDOW);
    // Window semantics are unchanged: the newest WINDOW deliveries stay remembered,
    // so cost-21 is still known and cost-20 was forgotten when cost-next arrived.
    await deliver('cost-next');
    await deliver('cost-21');
    await deliver('cost-20');
    const duplicate = async id => (await get('/api/events?delivery_id=' + id)).events.filter(e => e.duplicate).length;
    assert.equal(await duplicate('cost-next'), 1);
    assert.equal(await duplicate('cost-21'), 1);
    assert.equal(await duplicate('cost-20'), 0);
    assert.equal((await get('/api/status')).remembered_deliveries, WINDOW);
  });

  await t.test('a credential claim reads only the claims it expires', async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < 200; i++) assert.equal(await (await mf.dispatchFetch(`http://localhost/_test/claim?key=run-${i}&expires=${expires}`)).json(), true);
    await rows();
    assert.equal(await (await mf.dispatchFetch(`http://localhost/_test/claim?key=run-new&expires=${expires}`)).json(), true);
    const cost = await rows();
    assert.ok(cost.read <= 10, `rows read per claim: ${cost.read}`);
    assert.equal(await (await mf.dispatchFetch(`http://localhost/_test/claim?key=run-new&expires=${expires}`)).json(), false);
  });
});
