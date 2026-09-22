import { base64 } from './signature.js';
import { id, jsonBytes, nowISO, object, text, type Doc, type Reply } from './types.js';

export const safeHeaders = (headers: Headers): Doc => Object.fromEntries([...headers].map(([name, value]) => [name, /authorization|cookie|token|secret|signature|jwt|api[-_]?key/i.test(name) ? '[REDACTED]' : value]));
export function safeTarget(target: string): string {
  const url = new URL(target, 'http://local');
  const params = new URLSearchParams([...url.searchParams].map(([key]) => [key, '[REDACTED]']));
  return url.pathname + (params.size ? '?' + params : '');
}
export function responseHeaders(body: Doc): Headers {
  return new Headers({ Server: 'sciencediscovery-bot', Date: new Date().toUTCString(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(jsonBytes(body).length), 'Cache-Control': 'no-store' });
}
export function exchange(reply: Reply, headers: Headers, body: Uint8Array, context: Doc = {}): { record: Doc; detail: Doc } {
  const recordId = id(), day = nowISO().slice(0, 10);
  const request: Doc = { ...context, method: context.method || 'POST', path: safeTarget(String(context.path || '/webhook')), headers: safeHeaders(headers), body_complete: context.body_complete ?? true, body_bytes: body.length };
  const record: Doc = { ...reply.record, record_id: recordId, payload_file: `payloads/${day}/${recordId}.body`, detail_file: `deliveries/${day}/${recordId}.json`, payload_bytes: body.length,
    http_status: reply.status, body_complete: request.body_complete, request_method: request.method, request_path: request.path };
  if (context.replayed_from) record.extra = { ...object(record.extra), replayed_from: context.replayed_from };
  const detail = { request, response: { status: reply.status, headers: Object.fromEntries(reply.headers || responseHeaders(reply.body)), body: text(jsonBytes(reply.body)) } };
  return { record, detail };
}
export function withBody(record: Doc, detail: Doc | null, body: Uint8Array | null): Doc {
  const request: Doc = { ...object(detail?.request), body_available: body !== null, body: null };
  if (body !== null) {
    try { request.body = text(body); request.body_encoding = 'utf-8'; }
    catch { request.body = base64(body); request.body_encoding = 'base64'; }
  }
  return { record, request, response: detail?.response ?? null, legacy: detail === null };
}
export class Counters {
  private readonly remembered = new Map<string, true>();
  private counts = { accepted: 0, rejected: 0, ignored: 0, duplicate: 0, by_route: {} as Record<string, number> };
  private last: Doc | null = null;
  constructor(readonly window: number) {}
  seen(provider: string, delivery: string): boolean { return !!delivery && this.remembered.has(`${provider}:${delivery}`); }
  count(record: Doc): void {
    const status = record.status === 'accepted' || record.status === 'ignored' ? record.status : 'rejected';
    this.counts[status]++;
    if (record.duplicate) this.counts.duplicate++;
    else if (status === 'accepted') {
      const route = String(record.route || '');
      // Define own keys, including unusual event names such as "__proto__".
      Object.defineProperty(this.counts.by_route, route, { value: (Object.hasOwn(this.counts.by_route, route) ? this.counts.by_route[route] : 0) + 1, writable: true, enumerable: true, configurable: true });
    }
    if (status === 'accepted' && record.delivery_id) {
      const key = `${record.provider}:${record.delivery_id}`;
      this.remembered.delete(key); this.remembered.set(key, true);
      while (this.remembered.size > this.window) this.remembered.delete(this.remembered.keys().next().value!);
    }
    this.last = record;
  }
  status(): Doc { return structuredClone({ counts: this.counts, last: this.last, remembered_deliveries: this.remembered.size }); }
}
