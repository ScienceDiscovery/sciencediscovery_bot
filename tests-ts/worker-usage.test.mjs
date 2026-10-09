import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { ANALYTICS, analyticsService, fixtureDays } from './support/cloudflare-graphql.mjs';

const LIMITS = { requests: 100_000, duration_gb_s: 13_000, rows_read: 5_000_000, rows_written: 100_000 };
// The UTC days the fixture reports this month, newest first, as the Worker should assemble them.
const expectedDays = () => {
  const today = new Date().toISOString().slice(0, 10);
  return fixtureDays(today.slice(0, 8) + '01', today).reverse().map(day => ({ date: day.date, requests: day.requests,
    duration_gb_s: Math.round(day.activeTime / 1e6 * 0.128 * 100) / 100, rows_read: day.rowsRead, rows_written: day.rowsWritten }));
};
const overOf = day => Object.keys(LIMITS).filter(key => day[key] > LIMITS[key]);

const secret = 'usage-secret';
const signed = delivery => {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'openJiuwen-ai/sciencediscovery' }, issue: { number: 1, title: 'usage' } });
  return { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } };
};

async function runtime(t, bindings, service) {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-usage-'));
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-rows.mjs', outboundService: service?.handler,
    bindings: { SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_ADMIN_TOKEN: 'local-usage-admin', ...bindings } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { mf, directory, usage: async () => (await mf.dispatchFetch('http://localhost/_test/usage')).json() };
}

test('usage estimates month-to-date charges from aggregate analytics of this instance only', async t => {
  const service = analyticsService();
  const { mf, directory, usage } = await runtime(t, { SDBOT_ANALYTICS_TOKEN: ANALYTICS.token, SDBOT_CLOUDFLARE_ACCOUNT_ID: ANALYTICS.account,
    SDBOT_ARCHIVE_BUCKET: ANALYTICS.bucket }, service);
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', signed('usage-1'))).status, 200);
  const doc = await usage();
  // Four aggregate queries, filtered to this bucket and this object.
  assert.deepEqual(service.calls.map(call => call.dataset).sort(), ['durableObjectsInvocationsAdaptiveGroups', 'durableObjectsPeriodicGroups', 'r2OperationsAdaptiveGroups', 'r2StorageAdaptiveGroups']);
  for (const call of service.calls) {
    assert.equal(call.authorization, 'Bearer ' + ANALYTICS.token);
    assert.equal(call.variables.account, ANALYTICS.account);
    if (call.dataset.startsWith('r2')) assert.equal(call.variables.bucket, ANALYTICS.bucket);
    else assert.match(call.variables.object, /^[0-9a-f]{64}$/);
  }
  const month = new Date().toISOString().slice(0, 8) + '01';
  assert.equal(service.calls.find(call => call.dataset === 'r2OperationsAdaptiveGroups').variables.start, month + 'T00:00:00.000Z');
  assert.equal(doc.analytics.status, 'ok');
  assert.ok(doc.database.bytes > 0);
  assert.deepEqual({ ...doc.analytics.r2, sampled_at: undefined }, { storage_bytes: 12e9, object_count: 4200, sampled_at: undefined,
    class_a: 1_500_000, class_b: 2_000_000, free: 100, unclassified: { SomethingNew: 7 } });
  const d = doc.analytics.durable_objects;
  assert.deepEqual([d.requests, d.rows_read, d.rows_written, d.duration_gb_s], [1_500_000, 3e6, 60e6, 512000]);
  assert.deepEqual(d.namespace_ids, ['namespace-under-test']);
  const cost = Object.fromEntries(doc.estimate.lines.map(line => [line.item, line.cost]));
  // Overage at list prices: 0.5M requests, 112k GB-s, 10M rows written, 2 GB R2, 0.5M Class A.
  assert.deepEqual(cost, { '请求': 0.08, '时长（GB-s）': 1.4, 'SQLite 行读': 0, 'SQLite 行写': 10, 'SQLite 存储': 0, 'R2 存储': 0.03, 'R2 Class A': 2.25, 'R2 Class B': 0 });
  assert.equal(doc.estimate.total, 13.76);
  assert.deepEqual(doc.pricing.durable_objects.free_daily, LIMITS);
  // Every UTC day of the month with all four metrics; today carries requests and duration too.
  assert.deepEqual(d.days, expectedDays());
  assert.deepEqual(d.today, expectedDays()[0]);
  assert.deepEqual(doc.free_plan.days.map(day => [day.date, day.status, day.over]),
    expectedDays().map(day => [day.date, overOf(day).length ? 'over' : 'within', overOf(day)]));
  assert.deepEqual(doc.free_plan.days[0].over, ['requests', 'duration_gb_s', 'rows_written']);
  assert.equal(doc.free_plan.storage.over, false);
  assert.deepEqual([doc.pricing.durable_objects.as_of, doc.pricing.r2.as_of], ['2026-09-30', '2026-10-01']);
  // The token reaches only the Authorization header: not the response, not the stored cache.
  assert.doesNotMatch(JSON.stringify(doc), new RegExp(ANALYTICS.token));
  const state = resolve(directory, 'state/do');
  const files = await import('node:fs/promises').then(fs => fs.readdir(state, { recursive: true }));
  for (const file of files.filter(name => name.endsWith('.sqlite'))) assert.doesNotMatch((await readFile(resolve(state, file))).toString('latin1'), new RegExp(ANALYTICS.token));
  // Within six hours nothing is queried again.
  assert.equal((await usage()).analytics.fetched_at, doc.analytics.fetched_at);
  assert.equal(service.calls.length, 4);
});

test('a failing dataset leaves the others and never invents zero', async t => {
  const service = analyticsService({ fail: ['durableObjectsPeriodicGroups'], redirect: ['r2StorageAdaptiveGroups'] });
  const { usage } = await runtime(t, { SDBOT_ANALYTICS_TOKEN: ANALYTICS.token, SDBOT_CLOUDFLARE_ACCOUNT_ID: ANALYTICS.account,
    SDBOT_ARCHIVE_BUCKET: ANALYTICS.bucket }, service);
  const doc = await usage();
  assert.equal(doc.analytics.status, 'partial');
  assert.equal(doc.analytics.errors.do_periodic, 'unknown field in durableObjectsPeriodicGroups for Bearer [REDACTED]');
  assert.equal(doc.analytics.durable_objects.requests, 1_500_000);
  // A redirect is an error, never followed with the token.
  assert.equal(doc.analytics.errors.r2_storage, 'HTTP 302');
  assert.deepEqual(service.elsewhere, []);
  assert.equal(doc.analytics.r2.class_a, 1_500_000);
  assert.equal(doc.analytics.r2.storage_bytes, undefined);
  assert.equal(doc.analytics.durable_objects.rows_read, undefined);
  // Requests still come per day; the failed periodic metrics stay null and are not judged within.
  assert.deepEqual(doc.analytics.durable_objects.days, expectedDays().map(day => ({ ...day, duration_gb_s: null, rows_read: null, rows_written: null })));
  assert.deepEqual(doc.free_plan.days.map(day => [day.status, day.unknown]),
    expectedDays().map(day => [day.requests > LIMITS.requests ? 'over' : 'unknown', ['duration_gb_s', 'rows_read', 'rows_written']]));
  const rows = doc.estimate.lines.find(line => line.item === 'SQLite 行读');
  assert.deepEqual([rows.used, rows.cost], [null, null]);
  assert.equal(doc.estimate.total, null);
});

test('without the analytics token only local size and counters are shown', async t => {
  const service = analyticsService();
  const { mf, usage } = await runtime(t, { SDBOT_CLOUDFLARE_ACCOUNT_ID: ANALYTICS.account, SDBOT_ARCHIVE_BUCKET: ANALYTICS.bucket }, service);
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', signed('usage-2'))).status, 200);
  const doc = await usage();
  assert.deepEqual(doc.analytics, { status: 'unconfigured', message: '未配置 Analytics token，不能估算操作量' });
  assert.equal(doc.estimate, null);
  assert.ok(doc.database.bytes > 0);
  assert.equal(doc.archive.counts.accepted, 1);
  assert.equal(service.calls.length, 0);
  // The local Workers admin bridge serves the same section from the shared application, without cloud metering.
  const admin = await mf.getWorker('admin');
  const local = await (await admin.fetch('http://localhost/api/usage', { headers: { authorization: 'Bearer local-usage-admin' } })).json();
  assert.equal(local.analytics.status, 'unavailable');
  assert.ok(local.database.bytes > 0);
  assert.equal(local.archive.counts.accepted, 1);
});

test('every Wrangler configuration names the bucket it binds and the account for analytics', async () => {
  for (const file of ['wrangler.jsonc', 'wrangler.test.jsonc']) {
    const config = JSON.parse((await readFile(file, 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    assert.equal(config.vars.SDBOT_ARCHIVE_BUCKET, config.r2_buckets.find(bucket => bucket.binding === 'ARCHIVE').bucket_name, file);
    assert.match(config.vars.SDBOT_CLOUDFLARE_ACCOUNT_ID, /^[0-9a-f]{32}$/, file);
    assert.equal(config.vars.SDBOT_ANALYTICS_TOKEN, undefined, `${file}: the analytics token is a secret`);
  }
});
