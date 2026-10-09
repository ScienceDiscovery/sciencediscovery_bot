/// <reference types="@cloudflare/workers-types" />
import { r2Classes } from '../core/usage.js';
import { scrub } from '../core/redact.js';
import { object, string, type Doc } from '../core/types.js';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
/** Account analytics are fetched at most once per this interval, however often the page is opened. */
export const ANALYTICS_TTL_MS = 6 * 3600_000;

export interface AnalyticsSettings { token: string; account: string; bucket: string; objectId: string }
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

// Aggregate datasets only: nothing here lists R2 objects or reads per-object detail.
// Storage is sampled; the newest sample in the last week is the current size.
const R2_STORAGE = `query($account: string!, $bucket: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) {
  r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
    max { objectCount payloadSize metadataSize } dimensions { datetime } } } } }`;
const R2_OPERATIONS = `query($account: string!, $bucket: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) {
  r2OperationsAdaptiveGroups(limit: 1000, filter: { bucketName: $bucket, datetime_geq: $start, datetime_leq: $end }) {
    sum { requests } dimensions { actionType } } } } }`;
// The namespace holds a single object (archive-v1), so its object ID scopes the namespace.
// SQLite rows and active time are reported per object and day by the periodic dataset.
const DO_PERIODIC = `query($account: string!, $object: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: { accountTag: $account }) {
  durableObjectsPeriodicGroups(limit: 100, filter: { objectId: $object, date_geq: $start, date_leq: $end }) {
    sum { rowsRead rowsWritten activeTime } dimensions { date namespaceId } } } } }`;
const DO_INVOCATIONS = `query($account: string!, $object: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: { accountTag: $account }) {
  durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { objectId: $object, date_geq: $start, date_leq: $end }) {
    sum { requests } dimensions { date } } } } }`;

class AnalyticsError extends Error {}
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

async function query(fetcher: Fetch, settings: AnalyticsSettings, text: string, variables: Doc, dataset: string): Promise<Doc[]> {
  let response: Response;
  try {
    response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + settings.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: text, variables }) });
  } catch { throw new AnalyticsError('network error'); }
  if (!response.ok) throw new AnalyticsError(`HTTP ${response.status}`);
  const doc = object(await response.json().catch(() => ({})));
  const errors = Array.isArray(doc.errors) ? doc.errors : [];
  // GraphQL messages name fields or permissions; credentials are scrubbed before they are kept.
  if (errors.length) throw new AnalyticsError(scrub(string(object(errors[0]).message) || 'GraphQL error', [settings.token], 200));
  const accounts = object(object(doc.data).viewer).accounts;
  const rows = Array.isArray(accounts) ? object(accounts[0])[dataset] : undefined;
  if (!Array.isArray(rows)) throw new AnalyticsError('unexpected response');
  return rows.map(object);
}

/** Month-to-date (UTC) Cloudflare usage of this instance; each dataset fails on its own. */
export async function fetchAnalytics(settings: AnalyticsSettings, now: number, fetcher: Fetch): Promise<Doc> {
  const end = new Date(now), month = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const day = (date: Date) => date.toISOString().slice(0, 10), today = day(end);
  const base = { account: settings.account, end: end.toISOString() };
  const errors: Record<string, string> = {};
  const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run(); } catch (error) { errors[name] = error instanceof AnalyticsError ? error.message : 'unexpected error'; return null; }
  };
  const [storage, operations, periodic, invocations] = await Promise.all([
    attempt('r2_storage', () => query(fetcher, settings, R2_STORAGE, { ...base, bucket: settings.bucket, start: new Date(now - 7 * 86400_000).toISOString() }, 'r2StorageAdaptiveGroups')),
    attempt('r2_operations', () => query(fetcher, settings, R2_OPERATIONS, { ...base, bucket: settings.bucket, start: month.toISOString() }, 'r2OperationsAdaptiveGroups')),
    attempt('do_periodic', () => query(fetcher, settings, DO_PERIODIC, { account: settings.account, object: settings.objectId, start: day(month), end: today }, 'durableObjectsPeriodicGroups')),
    attempt('do_invocations', () => query(fetcher, settings, DO_INVOCATIONS, { account: settings.account, object: settings.objectId, start: day(month), end: today }, 'durableObjectsInvocationsAdaptiveGroups')),
  ]);
  const r2: Doc = {};
  if (storage) {
    const latest = object(storage[0]), max = object(latest.max);
    Object.assign(r2, { storage_bytes: storage.length ? number(max.payloadSize) + number(max.metadataSize) : 0,
      object_count: storage.length ? number(max.objectCount) : 0, sampled_at: string(object(latest.dimensions).datetime) || null });
  }
  if (operations) Object.assign(r2, r2Classes(operations.map(row => ({ action: string(object(row.dimensions).actionType), requests: number(object(row.sum).requests) }))));
  // One entry per UTC day either dataset reported. A metric whose dataset failed stays null:
  // unknown, never zero. A day missing from a dataset that answered had none of it.
  const days = new Map<string, { date: string; requests: number | null; active: number | null; rows_read: number | null; rows_written: number | null }>();
  const entry = (date: string) => {
    if (!days.has(date)) days.set(date, { date, requests: invocations ? 0 : null, active: periodic ? 0 : null, rows_read: periodic ? 0 : null, rows_written: periodic ? 0 : null });
    return days.get(date)!;
  };
  for (const row of periodic || []) {
    const value = entry(string(object(row.dimensions).date)), sum = object(row.sum);
    value.rows_read! += number(sum.rowsRead); value.rows_written! += number(sum.rowsWritten); value.active! += number(sum.activeTime);
  }
  for (const row of invocations || []) entry(string(object(row.dimensions).date)).requests! += number(object(row.sum).requests);
  // activeTime is in microseconds; duration bills 128 MB per active object.
  const gbs = (active: number | null) => active === null ? null : Math.round(active / 1e6 * 0.128 * 100) / 100;
  const daily = [...days.values()].filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date)).sort((a, b) => b.date.localeCompare(a.date))
    .map(({ active, ...day }) => ({ date: day.date, requests: day.requests, duration_gb_s: gbs(active), rows_read: day.rows_read, rows_written: day.rows_written }));
  const durable: Doc = { days: daily, today: daily.find(day => day.date === today) ?? { date: today, requests: invocations ? 0 : null,
    duration_gb_s: periodic ? 0 : null, rows_read: periodic ? 0 : null, rows_written: periodic ? 0 : null } };
  if (periodic) {
    const sum = (key: string) => periodic.reduce((total, row) => total + number(object(row.sum)[key]), 0);
    Object.assign(durable, { rows_read: sum('rowsRead'), rows_written: sum('rowsWritten'), duration_gb_s: gbs(sum('activeTime')),
      namespace_ids: [...new Set(periodic.map(row => string(object(row.dimensions).namespaceId)).filter(Boolean))] });
  }
  if (invocations) durable.requests = invocations.reduce((total, row) => total + number(object(row.sum).requests), 0);
  const failed = Object.keys(errors).length;
  return { status: failed === 4 ? 'error' : failed ? 'partial' : 'ok', period: { start: day(month), end: end.toISOString() },
    r2: storage || operations ? r2 : null, durable_objects: periodic || invocations ? durable : null, errors };
}

/**
 * One SQLite row caches the last fetch. The row is keyed by a fingerprint of the
 * cache format, account, bucket and token, so changing the token takes effect on the next read
 * while the token itself is never stored.
 */
export class AnalyticsCache {
  private ready = false;
  private pending: Promise<Doc> | null = null;
  constructor(readonly sql: SqlStorage, readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}
  private table(): void {
    // Created on first use, so webhook and token paths never pay for it.
    if (!this.ready) this.sql.exec('CREATE TABLE IF NOT EXISTS usage_cache (name TEXT PRIMARY KEY, fetched INTEGER NOT NULL, value TEXT NOT NULL)');
    this.ready = true;
  }
  async read(settings: AnalyticsSettings, now = Date.now()): Promise<Doc> {
    this.table();
    const key = await fingerprint(settings);
    const row = this.sql.exec<{ fetched: number; value: string }>("SELECT fetched, value FROM usage_cache WHERE name='analytics'").toArray()[0];
    if (row) {
      const cached = object(JSON.parse(row.value));
      if (cached.key === key && now - row.fetched < ANALYTICS_TTL_MS && now >= row.fetched) return present(cached.analytics, row.fetched);
    }
    // Concurrent page loads share one fetch.
    this.pending ||= (async () => {
      try {
        const analytics = await fetchAnalytics(settings, now, this.fetcher);
        this.sql.exec("INSERT INTO usage_cache VALUES ('analytics', ?, ?) ON CONFLICT(name) DO UPDATE SET fetched=excluded.fetched, value=excluded.value",
          now, JSON.stringify({ key, analytics }));
        return present(analytics, now);
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
}

const present = (analytics: unknown, fetched: number): Doc => ({ ...object(analytics), fetched_at: new Date(fetched).toISOString(),
  next_fetch_at: new Date(fetched + ANALYTICS_TTL_MS).toISOString() });

/** Bumped when the cached analytics document changes shape; an older row is then fetched again once. */
const CACHE_FORMAT = 'daily-v2';
async function fingerprint(settings: AnalyticsSettings): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([CACHE_FORMAT, settings.account, settings.bucket, settings.objectId, settings.token].join('\n')));
  return [...new Uint8Array(digest).slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
