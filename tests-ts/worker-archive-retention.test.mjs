import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';

// The production Durable Object and R2 in workerd: expired UTC days lose their deliveries rows and both R2
// objects, retained days and every other table stay, and each step reads only the rows it removes.
const secret = 'retention-secret', DAY = 86400000, now = Date.now();
const day = ago => new Date(now - ago * DAY).toISOString().slice(0, 10);
const OLD = day(90), RECENT = day(10), TODAY = day(0), ORPHAN_OLD = day(100), ORPHAN_NEW = day(5);
const signed = delivery => {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'openJiuwen-ai/sciencediscovery' }, issue: { number: 1, title: 'retention' } });
  return { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } };
};

test('Worker archive retention: 60-day UTC days, bounded batches, a one-time backlog cursor and an idle day marker', { timeout: 90000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-retention-'));
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-retention.mjs', bindings: { SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_ADMIN_TOKEN: 'local-test-admin' } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const call = async (name, body) => (await mf.dispatchFetch('http://localhost/_test/' + name, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
  const prune = async at => { await call('usage'); const result = await call('prune', { now: at }); return { result, usage: await call('usage') }; };
  const objects = async (d) => (await call('keys', { prefix: `payloads/${d}/` })).length + (await call('keys', { prefix: `deliveries/${d}/` })).length;
  const deliveriesQueries = usage => usage.statements.filter(s => /\bdeliveries\b/.test(s.query));
  const admin = await mf.getWorker('admin');
  const events = async () => (await (await admin.fetch('http://localhost/api/events?limit=500', { headers: { authorization: 'Bearer local-test-admin' } })).json()).events;

  // Rows an older release indexed (no archive_days), unindexed objects, and the tables retention must not touch.
  await call('seed-legacy', { days: [[OLD, 210], [RECENT, 40]] });
  await call('put', { keys: [`payloads/${ORPHAN_OLD}/lost.body`, `deliveries/${ORPHAN_OLD}/lost.json`, `payloads/${ORPHAN_NEW}/lost.body`] });
  await call('seed-sync');
  assert.equal(await call('claim', { key: 'run-1', expires: Math.floor(now / 1000) + 3600 }), true);
  for (let i = 0; i < 3; i++) assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', signed(`retention-${i}`))).status, 200);
  const before = await call('dump');
  assert.deepEqual(before.days, { [OLD]: 210, [RECENT]: 40, [TODAY]: 3 });
  assert.deepEqual(before.archive_days.map(d => d.day), [TODAY], 'new writes maintain archive_days; legacy rows do not have it yet');
  const untouched = d => ({ seen: d.seen, credential_claims: d.credential_claims, gitcode_sync_pulls: d.gitcode_sync_pulls, gitcode_sync_records: d.gitcode_sync_records,
    totals: d.totals, routes: d.routes, seen_counter: d.counters.seen });
  const invariant = untouched(before);
  assert.equal(invariant.seen, 3); assert.equal(invariant.gitcode_sync_pulls, 1); assert.equal(invariant.credential_claims, 1);

  // Backlog, first cron: the oldest 200 legacy rows, all expired.
  const first = await prune(now);
  assert.deepEqual(first.result, { status: 'backlog', rows: 200, objects: 400 });
  let state = await call('dump');
  assert.deepEqual(state.days, { [OLD]: 10, [RECENT]: 40, [TODAY]: 3 });
  assert.equal(await objects(OLD), 20, 'both objects of every deleted row are gone from R2');
  assert.equal(state.counters.archive_backlog_seq, 200);
  // Backlog, second cron: continues after the cursor and never reads the 200 deleted seqs again.
  const second = await prune(now);
  assert.deepEqual(second.result, { status: 'backlog', rows: 10, objects: 20 });
  const [scan] = deliveriesQueries(second.usage).filter(s => s.query.startsWith('SELECT'));
  // A range scan reads at most one row past its upper bound to see that it ended.
  assert.equal(scan.args[0], 200, 'the scan starts at the stored cursor'); assert.ok(scan.read >= 50 && scan.read <= 51, `rows read after the cursor: ${scan.read}`);
  state = await call('dump');
  assert.equal(state.counters.archive_backlog_done, 1);
  assert.deepEqual(state.days, { [RECENT]: 40, [TODAY]: 3 }); assert.equal(await objects(OLD), 0);
  assert.deepEqual(state.archive_days.map(d => d.day), [RECENT, TODAY], 'retained legacy rows are indexed by day');
  assert.equal(await objects(RECENT), 80, 'rows within 60 days keep both objects');

  // Unindexed objects: only expired date directories are emptied, after the backlog is done.
  const orphans = await prune(now);
  assert.deepEqual(orphans.result, { status: 'orphans', day: ORPHAN_OLD, objects: 2 });
  assert.equal(deliveriesQueries(orphans.usage).length, 0);
  assert.equal(await objects(ORPHAN_OLD), 0); assert.equal(await objects(ORPHAN_NEW), 1);
  const clean = await prune(now);
  assert.deepEqual(clean.result, { status: 'clean' }); assert.equal(deliveriesQueries(clean.usage).length, 0, 'nothing expired: deliveries is not queried');
  // The rest of the day: one counter row, no deliveries query.
  const idle = await prune(now);
  assert.deepEqual(idle.result, { status: 'idle' });
  assert.equal(idle.usage.statements.length, 1); assert.match(idle.usage.statements[0].query, /FROM counters/); assert.ok(idle.usage.read <= 1);
  assert.equal(deliveriesQueries(idle.usage).length, 0);

  // Steady state 61 days later: RECENT and TODAY have expired through archive_days. A crash after the
  // R2 delete is simulated by removing some objects first; the index rows still lead to the rest.
  const later = now + 61 * DAY;
  await call('drop', { keys: [`payloads/${RECENT}/${RECENT}-0.body`, `deliveries/${RECENT}/${RECENT}-0.json`] });
  const recent = await prune(later);
  assert.deepEqual(recent.result, { status: 'day', day: RECENT, rows: 40, objects: 80 });
  const [range] = deliveriesQueries(recent.usage).filter(s => s.query.startsWith('SELECT'));
  assert.ok(range.read >= 40 && range.read <= 41, `only that day's seq range is read: ${range.read}`);
  assert.equal(await objects(RECENT), 0);
  state = await call('dump');
  assert.deepEqual(state.days, { [TODAY]: 3 }); assert.deepEqual(state.archive_days.map(d => d.day), [TODAY]);
  assert.deepEqual((await prune(later)).result, { status: 'day', day: TODAY, rows: 3, objects: 6 });
  assert.deepEqual((await prune(later)).result, { status: 'orphans', day: ORPHAN_NEW, objects: 1 });
  assert.deepEqual((await prune(later)).result, { status: 'clean' });
  assert.deepEqual((await prune(later)).result, { status: 'idle' });
  state = await call('dump');
  assert.equal(state.deliveries, 0); assert.deepEqual(state.archive_days, []);
  assert.deepEqual(await events(), [], 'the event list only holds deliveries inside the retention period');
  // Dedupe window, cumulative counts, GitCode sync state and credential claims are untouched throughout.
  assert.deepEqual(untouched(state), invariant);
});
