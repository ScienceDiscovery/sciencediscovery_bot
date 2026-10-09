import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freePlan, usageDocument } from '../src/core/usage.js';

const day = (date: string, values: Record<string, number | null>) => ({ date, requests: 40_000, duration_gb_s: 1280, rows_read: 1_000_000, rows_written: 50_000, ...values });
const measured = (days: unknown[], errors = {}) => ({ status: Object.keys(errors).length ? 'partial' : 'ok', errors, durable_objects: { days } });

test('Free plan days are within, over by metric, or unknown, never zero for a failed metric', () => {
  const plan = freePlan(measured([
    day('2026-10-09', { rows_written: 100_001 }),
    day('2026-10-08', { requests: 100_001 }),
    day('2026-10-07', {}),
    // Exactly at a limit is still within it: only strictly greater is over.
    day('2026-10-06', { requests: 100_000, duration_gb_s: 13_000, rows_read: 5_000_000, rows_written: 100_000 }),
  ]), 90_000);
  assert.deepEqual(plan.limits, { requests: 100_000, duration_gb_s: 13_000, rows_read: 5_000_000, rows_written: 100_000 });
  const days = plan.days as { date: string; status: string; over: string[]; unknown: string[] }[];
  assert.deepEqual(days.map(d => [d.date, d.status, d.over]), [
    ['2026-10-09', 'over', ['rows_written']], ['2026-10-08', 'over', ['requests']], ['2026-10-07', 'within', []], ['2026-10-06', 'within', []]]);
  assert.deepEqual(plan.storage, { bytes: 90_000, limit_bytes: 5_000_000_000, over: false });
});

test('a failed dataset leaves its metric unknown, so the day is not counted as within', () => {
  const plan = freePlan(measured([
    day('2026-10-09', { requests: null, rows_written: 200_000 }),
    day('2026-10-08', { requests: null }),
  ], { do_invocations: 'HTTP 500' }), null);
  const days = plan.days as Record<string, unknown>[];
  assert.equal(days[0].requests, null);
  assert.deepEqual([days[0].status, days[0].over, days[0].unknown], ['over', ['rows_written'], ['requests']]);
  assert.deepEqual([days[1].requests, days[1].status, days[1].over, days[1].unknown], [null, 'unknown', [], ['requests']]);
  // Without databaseSize the storage total cannot be judged either.
  assert.deepEqual(plan.storage, { bytes: null, limit_bytes: 5_000_000_000, over: null });
});

test('no day table when Durable Object metering is missing; storage is still compared with 5 GB', () => {
  const unconfigured = freePlan({ status: 'unconfigured', message: '未配置 Analytics token，不能估算操作量' }, 6_000_000_000);
  assert.deepEqual([unconfigured.days, unconfigured.reason], [null, '未配置 Analytics token，不能估算操作量']);
  assert.deepEqual(unconfigured.storage, { bytes: 6_000_000_000, limit_bytes: 5_000_000_000, over: true });
  const failed = freePlan({ status: 'partial', errors: { do_periodic: 'HTTP 500', do_invocations: 'network error', r2_storage: 'HTTP 500' }, durable_objects: null, r2: {} }, 1);
  assert.deepEqual([failed.days, failed.reason], [null, '读取失败：do_periodic（HTTP 500）；do_invocations（network error）']);
  // The usage document always carries the Free plan view next to the Paid estimate.
  const doc = usageDocument('local', { counts: {}, remembered_deliveries: 0 }, { status: 'unavailable', message: '本机运行没有 Cloudflare 云端计量' });
  assert.deepEqual([(doc.free_plan as Record<string, unknown>).days, (doc.free_plan as Record<string, unknown>).reason], [null, '本机运行没有 Cloudflare 云端计量']);
});
