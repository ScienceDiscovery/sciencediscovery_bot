import { PROVIDERS, tracks, type Config } from './config.js';
import { responseHeaders } from './archive.js';
import { Router } from './bus.js';
import { normalize } from './events.js';
import { detectProvider, verify } from './signature.js';
import { Mutex, eventSummary, nowISO, outcome, routeOf, text, type Archive, type Doc, type Reply } from './types.js';

export function parseBody(headers: Headers, body: Uint8Array): Doc {
  let value = text(body);
  if ((headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded') value = new URLSearchParams(value).get('payload') || '';
  const doc: unknown = JSON.parse(value || 'null');
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new TypeError('body must be a JSON object');
  return doc as Doc;
}
export function rejected(headers: Headers, status: number, error: string, reason = error, provider = detectProvider(headers)): Reply {
  return { status, body: { ok: false, error }, record: { received_at: nowISO(), status: 'rejected', provider,
    delivery_id: headers.get('x-github-delivery') || headers.get('x-gitcode-delivery') || '', raw_event: headers.get('x-github-event') || headers.get('x-gitcode-event') || '',
    kind: '', action: '', route: 'rejected', handled: false, reason, http_status: status, hooks: [] } };
}
export class Pipeline {
  private readonly mutex = new Mutex();
  constructor(readonly cfg: Config, readonly store: Archive, readonly router = new Router()) {}
  /** The archive commit and duplicate check are one serialized operation in this runtime. */
  async receive(headers: Headers, body: Uint8Array, hint?: string, request: Doc = {}, override?: Reply): Promise<Reply> {
    return this.mutex.run(async () => {
      let reply: Reply;
      try { reply = override || await this.process(headers, body, hint); }
      catch { reply = rejected(headers, 500, 'internal error'); }
      reply.headers = responseHeaders(reply.body);
      await this.store.save(reply, headers, body, request);
      return reply;
    });
  }
  private async process(headers: Headers, body: Uint8Array, hint?: string): Promise<Reply> {
    const provider = hint || detectProvider(headers);
    if (!(PROVIDERS as readonly string[]).includes(provider)) return rejected(headers, 400, 'bad request', 'unknown provider: expected X-GitHub-Event or X-GitCode-Event', provider);
    const verification = await verify(provider, headers, body, this.cfg.secrets[provider]);
    if (!verification.ok) return rejected(headers, 401, 'signature verification failed', `signature verification failed: ${verification.reason}`, provider);
    let payload: Doc;
    try { payload = parseBody(headers, body); } catch { return rejected(headers, 400, 'bad request', 'invalid body: expected a UTF-8 JSON object', provider); }
    const event = normalize(provider, headers, payload);
    const ignored = event.kind !== 'ping' && !tracks(this.cfg, event.repo, event.provider);
    let result;
    if (ignored) result = outcome(routeOf(event), `repo ${event.repo} not in SDBOT_REPOS`);
    else if (await this.store.seen(provider, event.delivery_id)) result = { ...outcome(routeOf(event), 'redelivery of an already processed delivery id'), duplicate: true };
    else result = await this.router.dispatch(event);
    return { status: 200, body: { ok: true, delivery_id: event.delivery_id, ...(event.kind === 'ping' ? { pong: true } : {}) }, record: {
      ...eventSummary(event), received_at: nowISO(), status: ignored ? 'ignored' : 'accepted', ...result, verification: verification.mode,
    } };
  }
}
