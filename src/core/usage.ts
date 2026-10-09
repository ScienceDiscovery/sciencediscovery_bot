import type { Doc } from './types.js';

/**
 * Published Cloudflare list prices behind the admin usage estimate. The estimate
 * is not an invoice: billing periods, plan, rounding and account-wide usage of
 * other Workers can differ from what this instance sees.
 */
export const PRICING = {
  durable_objects: {
    source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/', as_of: '2026-09-30',
    // Paid plan: monthly allowance, then the overage price per unit below.
    paid: [
      { key: 'requests', label: '请求', included: 1_000_000, unit: 1_000_000, price: 0.15, per: '百万次' },
      { key: 'duration_gb_s', label: '时长（GB-s）', included: 400_000, unit: 1_000_000, price: 12.5, per: '百万 GB-s' },
      { key: 'rows_read', label: 'SQLite 行读', included: 25_000_000_000, unit: 1_000_000, price: 0.001, per: '百万行' },
      { key: 'rows_written', label: 'SQLite 行写', included: 50_000_000, unit: 1_000_000, price: 1, per: '百万行' },
      { key: 'storage_gb_month', label: 'SQLite 存储', included: 5, unit: 1, price: 0.2, per: 'GB-month' },
    ],
    // Free plan: daily limits reset at 00:00 UTC; a spent limit makes those calls fail rather than cost more.
    free_daily: { requests: 100_000, duration_gb_s: 13_000, rows_read: 5_000_000, rows_written: 100_000 },
    // Free plan SQLite storage is a total, not a daily allowance.
    free_storage_bytes: 5_000_000_000,
    // Duration bills the 128 MB each active object is allocated.
    gb_per_object: 0.128,
  },
  r2: {
    source: 'https://developers.cloudflare.com/r2/pricing/', as_of: '2026-10-01', storage_class: 'Standard',
    monthly: [
      { key: 'storage_gb_month', label: 'R2 存储', included: 10, unit: 1, price: 0.015, per: 'GB-month' },
      { key: 'class_a', label: 'R2 Class A', included: 1_000_000, unit: 1_000_000, price: 4.5, per: '百万次' },
      { key: 'class_b', label: 'R2 Class B', included: 10_000_000, unit: 1_000_000, price: 0.36, per: '百万次' },
    ],
  },
} as const;

// R2 operation classes as listed on the pricing page; deletes and aborts are free.
const CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors',
  'PutBucketLifecycleConfiguration']);
const CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration']);
const FREE = new Set(['DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload']);

export const GB = 1_000_000_000;

/** Sums R2 requests by pricing class; unknown action types stay visible instead of being guessed. */
export function r2Classes(rows: { action: string; requests: number }[]): { class_a: number; class_b: number; free: number; unclassified: Record<string, number> } {
  const out = { class_a: 0, class_b: 0, free: 0, unclassified: {} as Record<string, number> };
  for (const { action, requests } of rows) {
    if (CLASS_A.has(action)) out.class_a += requests;
    else if (CLASS_B.has(action)) out.class_b += requests;
    else if (FREE.has(action)) out.free += requests;
    else out.unclassified[action] = (out.unclassified[action] || 0) + requests;
  }
  return out;
}

type Line = { key: string; label: string; included: number; unit: number; price: number; per: string };
const charge = (line: Line, used: number | null): Doc => used === null
  ? { item: line.label, used: null, included: line.included, unit_price: line.price, per: line.per, cost: null }
  : { item: line.label, used, included: line.included, unit_price: line.price, per: line.per,
      cost: Math.round(Math.max(0, used - line.included) / line.unit * line.price * 100) / 100 };

/**
 * Month-to-date overage at list prices. Operation counts are the month so far;
 * storage is the current size held for a whole month. Missing metrics stay null.
 */
export function estimate(metrics: { durable_objects?: Doc | null; r2?: Doc | null }, databaseBytes: number | null): Doc {
  const d = metrics.durable_objects || null, r = metrics.r2 || null;
  const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const doUsed: Record<string, number | null> = {
    requests: num(d?.requests), duration_gb_s: num(d?.duration_gb_s), rows_read: num(d?.rows_read), rows_written: num(d?.rows_written),
    storage_gb_month: databaseBytes === null ? null : databaseBytes / GB,
  };
  const r2Used: Record<string, number | null> = {
    storage_gb_month: num(r?.storage_bytes) === null ? null : (r?.storage_bytes as number) / GB, class_a: num(r?.class_a), class_b: num(r?.class_b),
  };
  const lines = [...PRICING.durable_objects.paid.map(line => charge(line, doUsed[line.key])), ...PRICING.r2.monthly.map(line => charge(line, r2Used[line.key]))];
  const known = lines.every(line => line.cost !== null);
  return { lines, total: known ? Math.round(lines.reduce((sum, line) => sum + (line.cost as number), 0) * 100) / 100 : null };
}

const FREE_DAILY = ['requests', 'duration_gb_s', 'rows_read', 'rows_written'] as const;

/**
 * The Free plan read against this object's own days: a day is over when any known metric is
 * strictly above its daily limit, and unknown when a metric could not be read and none is over.
 * Free limits are per account, so a day within them here does not clear the account.
 */
export function freePlan(analytics: Doc, databaseBytes: number | null): Doc {
  const limits = PRICING.durable_objects.free_daily, durable = analytics.durable_objects as Doc | null | undefined;
  const measured = analytics.status === 'ok' || analytics.status === 'partial';
  const storage = { bytes: databaseBytes, limit_bytes: PRICING.durable_objects.free_storage_bytes,
    over: databaseBytes === null ? null : databaseBytes > PRICING.durable_objects.free_storage_bytes };
  if (!measured || !durable || !Array.isArray(durable.days)) {
    const errors = Object.entries((analytics.errors as Record<string, string>) || {}).filter(([name]) => name.startsWith('do_'));
    return { limits, storage, days: null, reason: measured ? `读取失败：${errors.map(([name, message]) => `${name}（${message}）`).join('；') || 'Durable Object 数据集'}` : analytics.message || '云端计量不可用' };
  }
  const days = (durable.days as Doc[]).map(day => {
    const value = (key: typeof FREE_DAILY[number]) => typeof day[key] === 'number' ? day[key] as number : null;
    const over = FREE_DAILY.filter(key => { const used = value(key); return used !== null && used > limits[key]; });
    const unknown = FREE_DAILY.filter(key => value(key) === null);
    return { date: day.date, requests: value('requests'), duration_gb_s: value('duration_gb_s'), rows_read: value('rows_read'), rows_written: value('rows_written'),
      over, unknown, status: over.length ? 'over' : unknown.length ? 'unknown' : 'within' };
  });
  return { limits, storage, days, reason: null };
}

/**
 * The /api/usage document: local counters always; Cloudflare metrics and the
 * estimate only when account analytics were read. Nothing is filled with zero.
 */
export function usageDocument(runtime: string, local: Doc, analytics: Doc): Doc {
  const bytes = typeof local.database_bytes === 'number' ? local.database_bytes : null;
  const measured = analytics.status === 'ok' || analytics.status === 'partial';
  return { ok: true, runtime, generated_at: new Date().toISOString(), database: { bytes },
    archive: { counts: local.counts ?? null, remembered_deliveries: local.remembered_deliveries ?? null },
    analytics, estimate: measured ? estimate({ durable_objects: analytics.durable_objects as Doc | null, r2: analytics.r2 as Doc | null }, bytes) : null,
    free_plan: freePlan(analytics, bytes), pricing: PRICING };
}
