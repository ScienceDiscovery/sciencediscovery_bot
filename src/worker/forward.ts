/// <reference types="@cloudflare/workers-types" />
import { FORWARD_HISTORY, FORWARD_LIMIT, deliver, deliverTest, forwardable, forwardTestSample, generateForwardSecret, matches,
  parseSubscription, publicSubscription, signatureMode, sourceForwardHeaders, type ForwardResult, type ForwardSubscription, type ForwardTestSample } from '../core/forward.js';
import { object, string, type Doc } from '../core/types.js';

export interface AdminReply { status: number; body: Doc }
export const FORWARD_RETRY_WINDOW = 24 * 3600_000;
const LEASE_MS = 120000, RETRY_BATCH = 10;
interface RetryJob {
  id: string; subscription: string; record: Doc; headers: [string, string][];
  first_failure: number; expires: number; attempts: number; sample?: ForwardTestSample;
}
export const retryableForward = (result: ForwardResult): boolean => result.status === 408 || result.status === 429
  || (result.status !== null && result.status >= 500 && result.status <= 599)
  || (result.status === null && (result.error === 'network error' || result.error === 'timed out after 5 s'));
export const forwardRetryDelay = (attempt: number): number => Math.min(30000 * 2 ** Math.min(attempt - 1, 7), 3600_000);
const retryRecord = (record: Doc): Doc => Object.fromEntries(['record_id', 'payload_file', 'provider', 'kind', 'action', 'repo', 'delivery_id']
  .map(key => [key, record[key]]));

/** Subscriptions stay cached. Only failed sends create retry rows; bodies stay in the archive. */
export class WorkerForwards {
  private cache: ForwardSubscription[] | null = null;
  private retryReady = false;
  constructor(readonly storage: DurableObjectStorage, readonly fetcher: typeof fetch = (...args) => fetch(...args),
    readonly payload: (record: Doc) => Promise<Uint8Array | null> = async () => null,
    readonly arm: (at: number) => Promise<void> = async at => {
      const current = await storage.getAlarm();
      if (current === null || at < current) await storage.setAlarm(at);
    }, readonly clock: () => number = () => Date.now()) {}
  private list(): ForwardSubscription[] {
    if (!this.cache) {
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS forward_subscriptions (id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
      this.cache = this.storage.sql.exec<{ doc: string }>('SELECT doc FROM forward_subscriptions').toArray().map(row => JSON.parse(row.doc) as ForwardSubscription)
        .sort((a, b) => a.created.localeCompare(b.created));
    }
    return this.cache;
  }
  private save(sub: ForwardSubscription): void {
    this.storage.sql.exec('INSERT INTO forward_subscriptions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc', sub.id, JSON.stringify(sub));
  }
  private signing(sub: ForwardSubscription): ForwardSubscription {
    // Legacy unsigned subscriptions acquire one durable relay key on use, never in a startup sweep.
    if (!sub.secret) { sub.secret = generateForwardSecret(); this.save(sub); }
    return { ...sub, signature_mode: signatureMode(sub) };
  }
  private retries(): SqlStorage {
    if (!this.retryReady) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS forward_retries (id TEXT PRIMARY KEY, subscription TEXT NOT NULL, due INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS forward_retry_due ON forward_retries(due);
        CREATE INDEX IF NOT EXISTS forward_retry_subscription ON forward_retries(subscription);`);
      this.retryReady = true;
    }
    return this.storage.sql;
  }
  /** Called by cron/alarm, never by the successful ingestion path. */
  async schedule(): Promise<void> {
    const due = this.retries().exec<{ due: number | null }>('SELECT MIN(due) AS due FROM forward_retries').one().due;
    if (due !== null) await this.arm(Math.max(this.clock() + 100, due));
  }
  dispatch(record: Doc, headers: Headers, body: Uint8Array, waitUntil: (promise: Promise<unknown>) => void): void {
    if (!forwardable(record)) return;
    for (const sub of this.list().filter(sub => matches(sub, record))) waitUntil(this.attempt(sub, record, headers, body));
  }
  private record(id: string, result: ForwardResult): void {
    const sub = this.list().find(item => item.id === id);
    if (!sub) return;
    sub.recent = [result, ...(sub.recent || (sub.last ? [sub.last] : []))].slice(0, FORWARD_HISTORY);
    sub.last = result;
    this.save(sub);
  }
  private async attempt(sub: ForwardSubscription, record: Doc, headers: Headers, body: Uint8Array,
    job?: RetryJob, sample?: ForwardTestSample): Promise<{ result: ForwardResult; excerpt: string | null }> {
    record = { ...record, delivery_id: string(record.delivery_id) || string(record.record_id) };
    const signed = this.signing(sub), now = () => new Date(this.clock());
    let sent: { result: ForwardResult; excerpt: string | null };
    try {
      sent = sample ? await deliverTest(signed, this.fetcher, now, sample)
        : { result: await deliver(signed, record, body, headers, this.fetcher, now), excerpt: null };
    } catch {
      sent = { result: { at: now().toISOString(), delivery_id: string(record.delivery_id), status: null, error: 'signing unavailable',
        event: string(record.kind), repo: string(record.repo), ...(sample ? { test: true } : {}) }, excerpt: null };
    }
    if (!this.list().some(item => item.id === sub.id)) return sent;
    const first = job?.first_failure ?? this.clock(), attempts = (job?.attempts ?? 0) + 1;
    const due = this.clock() + forwardRetryDelay(attempts), expires = job?.expires ?? first + FORWARD_RETRY_WINDOW;
    const retry = retryableForward(sent.result) && due <= expires;
    Object.assign(sent.result, { attempt: attempts, ...(retry ? { retry_at: new Date(due).toISOString() } : { terminal: true }) });
    this.storage.transactionSync(() => {
      this.record(sub.id, sent.result);
      if (retry) {
        const next: RetryJob = job ? { ...job, attempts } : { id: `${sub.id}:${record.delivery_id}`, subscription: sub.id,
          record: retryRecord(record), headers: [...sourceForwardHeaders(headers)], first_failure: first, expires, attempts, ...(sample ? { sample } : {}) };
        this.retries().exec('INSERT INTO forward_retries VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due, doc=excluded.doc',
          next.id, sub.id, due, JSON.stringify(next));
      } else if (job) this.retries().exec('DELETE FROM forward_retries WHERE id=?', job.id);
    });
    if (retry) await this.arm(due);
    return sent;
  }
  /** Lease due work synchronously; every network request happens outside the ingestion mutex. */
  async run(): Promise<void> {
    const now = this.clock(), sql = this.retries();
    const jobs = this.storage.transactionSync(() => {
      const rows = sql.exec<{ id: string; doc: string }>('SELECT id, doc FROM forward_retries WHERE due <= ? ORDER BY due LIMIT ?', now, RETRY_BATCH).toArray();
      for (const row of rows) sql.exec('UPDATE forward_retries SET due=? WHERE id=?', now + LEASE_MS, row.id);
      return rows.map(row => JSON.parse(row.doc) as RetryJob);
    });
    await this.schedule(); // A process restart can recover an in-flight lease.
    await Promise.all(jobs.map(async job => {
      const sub = this.list().find(item => item.id === job.subscription);
      if (!sub) { sql.exec('DELETE FROM forward_retries WHERE id=?', job.id); return; }
      const body = job.sample ? new Uint8Array() : await this.payload(job.record);
      if (body === null || this.clock() > job.expires) {
        this.storage.transactionSync(() => {
          this.record(sub.id, { at: new Date(this.clock()).toISOString(), delivery_id: string(job.record.delivery_id), status: null,
            error: body === null ? 'archive body unavailable' : 'retry window expired', event: string(job.record.kind), repo: string(job.record.repo),
            attempt: job.attempts + 1, terminal: true, ...(job.sample ? { test: true } : {}) });
          sql.exec('DELETE FROM forward_retries WHERE id=?', job.id);
        });
        return;
      }
      await this.attempt(sub, job.record, new Headers(job.headers), body, job, job.sample);
    }));
    await this.schedule();
  }
  /** A new relay delivery, not a replay of the ingestion pipeline or its business listeners. */
  manual(record: Doc, headers: Headers, body: Uint8Array, waitUntil: (promise: Promise<unknown>) => void): AdminReply {
    const targets = ['accepted', 'ignored'].includes(string(record.status)) ? this.list().filter(sub => matches(sub, record)) : [];
    if (!targets.length) return { status: 422, body: { ok: false, error: 'no matching subscriptions' } };
    const delivery = `manual-${record.record_id}-${crypto.randomUUID().slice(0, 8)}`;
    for (const sub of targets) waitUntil(this.attempt(sub, { ...record, delivery_id: delivery }, headers, body));
    return { status: 202, body: { ok: true, webhook_id: delivery, subscriptions: targets.length } };
  }
  async test(id: string): Promise<AdminReply> {
    const sub = this.list().find(item => item.id === id);
    if (!sub) return { status: 404, body: { ok: false, error: 'subscription not found' } };
    const sample = forwardTestSample(sub, () => new Date(this.clock()));
    const { result, excerpt } = await this.attempt(sub, { provider: 'test', kind: 'ping', delivery_id: sample.delivery, repo: '' }, new Headers(), new Uint8Array(), undefined, sample);
    return { status: 200, body: { ok: true, result, response_excerpt: excerpt } };
  }
  admin(method: string, id: string | null, input: unknown): AdminReply {
    const subs = this.list(), index = id ? subs.findIndex(sub => sub.id === id) : -1;
    if (method === 'GET' && !id) return { status: 200, body: { ok: true, limit: FORWARD_LIMIT, history: FORWARD_HISTORY, subscriptions: subs.map(publicSubscription) } };
    if (id && index < 0) return { status: 404, body: { ok: false, error: 'subscription not found' } };
    if (method === 'DELETE' && id) {
      this.storage.transactionSync(() => { this.storage.sql.exec('DELETE FROM forward_subscriptions WHERE id=?', id); this.retries().exec('DELETE FROM forward_retries WHERE subscription=?', id); });
      subs.splice(index, 1);
      return { status: 200, body: { ok: true } };
    }
    if (method === 'POST' && !id || method === 'PUT' && id) {
      const doc = object(input);
      const parsed = parseSubscription({ ...doc, ...(id && doc.secret === undefined ? { secret: subs[index].secret } : {}), ...(id && doc.signature_mode === undefined ? { signature_mode: signatureMode(subs[index]) } : {}) });
      if (!parsed.ok) return { status: 422, body: { ok: false, error: parsed.error } };
      if (!id && subs.length >= FORWARD_LIMIT) return { status: 422, body: { ok: false, error: `at most ${FORWARD_LIMIT} subscriptions` } };
      const now = new Date(this.clock()).toISOString();
      const sub: ForwardSubscription = id ? { ...subs[index], ...parsed.value, updated: now }
        : { id: crypto.randomUUID(), ...parsed.value, created: now, updated: now, last: null };
      this.save(sub);
      if (id) subs[index] = sub; else subs.push(sub);
      return { status: id ? 200 : 201, body: { ok: true, subscription: publicSubscription(sub) } };
    }
    return { status: 405, body: { ok: false, error: 'method not allowed' } };
  }
}
