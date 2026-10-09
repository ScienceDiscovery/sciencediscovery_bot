/// <reference types="@cloudflare/workers-types" />
import { FORWARD_LIMIT, deliver, forwardable, matches, parseSubscription, publicSubscription, type ForwardResult, type ForwardSubscription } from '../core/forward.js';
import type { Doc } from '../core/types.js';

export interface AdminReply { status: number; body: Doc }

/**
 * Forward subscriptions in the bot's Durable Object. The list is read once per object
 * lifetime and kept in memory, so an incoming webhook costs no extra SQLite reads.
 * Webhook bodies are never stored again; only each subscription's last result is kept.
 */
export class WorkerForwards {
  private cache: ForwardSubscription[] | null = null;
  constructor(readonly storage: DurableObjectStorage, readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
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
  /** Starts deliveries for a record that has just been archived; the webhook reply never waits for them. */
  dispatch(record: Doc, headers: Headers, body: Uint8Array, waitUntil: (promise: Promise<unknown>) => void): void {
    if (!forwardable(record)) return;
    const targets = this.list().filter(sub => matches(sub, record));
    if (!targets.length) return;
    const contentType = headers.get('content-type') || 'application/json';
    for (const sub of targets) waitUntil(deliver(sub, record, body, contentType, this.fetcher).then(result => this.record(sub.id, result)).catch(() => undefined));
  }
  private record(id: string, result: ForwardResult): void {
    const sub = this.list().find(item => item.id === id);
    // A subscription deleted while its delivery was in flight stays deleted.
    if (!sub) return;
    sub.last = result;
    this.save(sub);
  }
  /** Access-authenticated management: list, create, update, delete. */
  admin(method: string, id: string | null, input: unknown): AdminReply {
    const subs = this.list(), index = id ? subs.findIndex(sub => sub.id === id) : -1;
    if (method === 'GET' && !id) return { status: 200, body: { ok: true, limit: FORWARD_LIMIT, subscriptions: subs.map(publicSubscription) } };
    if (id && index < 0) return { status: 404, body: { ok: false, error: 'subscription not found' } };
    if (method === 'DELETE' && id) {
      this.storage.sql.exec('DELETE FROM forward_subscriptions WHERE id=?', id);
      subs.splice(index, 1);
      return { status: 200, body: { ok: true } };
    }
    if (method === 'POST' && !id || method === 'PUT' && id) {
      const parsed = parseSubscription(input);
      if (!parsed.ok) return { status: 422, body: { ok: false, error: parsed.error } };
      if (!id && subs.length >= FORWARD_LIMIT) return { status: 422, body: { ok: false, error: `at most ${FORWARD_LIMIT} subscriptions` } };
      const now = new Date().toISOString();
      const sub: ForwardSubscription = id ? { ...subs[index], ...parsed.value, updated: now }
        : { id: crypto.randomUUID(), ...parsed.value, created: now, updated: now, last: null };
      this.save(sub);
      if (id) subs[index] = sub; else subs.push(sub);
      return { status: id ? 200 : 201, body: { ok: true, subscription: publicSubscription(sub) } };
    }
    return { status: 405, body: { ok: false, error: 'method not allowed' } };
  }
}
