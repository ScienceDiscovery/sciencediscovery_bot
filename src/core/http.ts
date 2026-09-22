import { publicConfig } from './config.js';
import { responseHeaders } from './archive.js';
import { Pipeline, rejected } from './pipeline.js';
import { detectProvider, equalSecret, sign } from './signature.js';
import { jsonBytes, object, string, type Doc, type Reply } from './types.js';

export const VERSION = '0.4.0';
export interface Capture { body: Uint8Array; complete: boolean; declared: number | null; note: string; error?: { status: number; message: string }; }
export const jsonResponse = (body: Doc, status = 200, headers = responseHeaders(body)): Response => new Response(jsonBytes(body), { status, headers });
export const replyResponse = (reply: Reply): Response => jsonResponse(reply.body, reply.status, reply.headers);
export async function captureBody(request: Request, maximum: number): Promise<Capture> {
  const length = request.headers.get('content-length');
  const declared = length === null ? null : /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : -1;
  const capture: Capture = { body: new Uint8Array(), complete: false, declared, note: '' };
  if (declared === -1) return { ...capture, error: { status: 400, message: 'bad request' }, note: 'invalid Content-Length; body not read' };
  const chunks: Uint8Array[] = []; let total = 0;
  const reader = request.body?.getReader();
  try {
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      chunks.push(value.subarray(0, Math.max(0, maximum - total))); total += value.length;
      if (total > maximum || (declared !== null && declared > maximum && total >= maximum)) { await reader.cancel(); break; }
    }
    capture.complete = declared === null ? total <= maximum : total === declared && total <= maximum;
  } catch { capture.note = 'request body interrupted or timed out'; }
  const bytes = new Uint8Array(Math.min(total, maximum)); let pos = 0;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; } capture.body = bytes;
  if ((declared ?? total) > maximum || total > maximum) {
    capture.error = { status: 413, message: 'payload too large' }; capture.note = 'body exceeds request limit; only received prefix retained';
  } else if (!capture.complete) { capture.error = { status: 400, message: 'incomplete body' }; capture.note ||= 'incomplete request body'; }
  return capture;
}
export class BotApplication {
  private readonly started = Date.now();
  constructor(readonly pipeline: Pipeline, readonly panel: () => Promise<string>) {}
  async webhook(request: Request, supplied?: Capture): Promise<Response> {
    const started = performance.now(), path = new URL(request.url).pathname;
    const archive = !['GET', 'HEAD'].includes(request.method) || !!detectProvider(request.headers);
    if (!archive) {
      const response = request.method === 'GET' && path === '/healthz' ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: 'not found' }, 404);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    const capture = supplied || await captureBody(request, this.pipeline.cfg.max_body_bytes);
    let override: Reply | undefined, hint: string | undefined;
    if (capture.error) override = rejected(request.headers, capture.error.status, capture.error.message);
    else if (request.method !== 'POST' || !['/webhook', '/webhook/github', '/webhook/gitcode'].includes(path)) override = rejected(request.headers, 404, 'not found');
    else hint = path === '/webhook' ? undefined : path.split('/')[2];
    try {
      const reply = await this.pipeline.receive(request.headers, capture.body, hint, { source: 'webhook', method: request.method, path: request.url,
        body_complete: capture.complete, declared_body_bytes: capture.declared, capture_note: capture.note, duration_ms: Math.round((performance.now() - started) * 100) / 100 }, override);
      const response = replyResponse(reply);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    } catch { return jsonResponse({ ok: false, error: 'storage unavailable' }, 503); }
  }
  async admin(request: Request): Promise<Response> {
    const cfg = this.pipeline.cfg, url = new URL(request.url), path = url.pathname, store = this.pipeline.store;
    const fail = (error: string, status: number) => jsonResponse({ ok: false, error }, status);
    if ([...request.headers.keys()].some(key => key.toLowerCase().startsWith('cf-'))) return fail('admin listener is local only', 403);
    const shell = request.method === 'GET' && ['/', '/index.html'].includes(path);
    if (!shell && cfg.admin_token && !await equalSecret(request.headers.get('authorization') || '', `Bearer ${cfg.admin_token}`)) return fail('unauthorized', 401);
    try {
      if (shell) return new Response(await this.panel(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', Server: 'sciencediscovery-bot' } });
      if (request.method === 'GET') {
        if (path === '/healthz') return jsonResponse({ ok: true, uptime_s: Math.round((Date.now() - this.started) / 100) / 10 });
        if (path === '/api/status') return jsonResponse({ ok: true, version: VERSION, started_at: this.started / 1000, board: this.pipeline.router.board.status(), config: publicConfig(cfg), ...await store.status() });
        if (path === '/api/listeners') return jsonResponse({ ok: true, listeners: this.pipeline.router.bus.inventory(), repositories: cfg.repos });
        if (path === '/api/events') {
          const limitText = url.searchParams.get('limit') ?? '50', offsetText = url.searchParams.get('offset') ?? '0';
          if (![limitText, offsetText].every(v => /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v)))) return fail('limit and offset must be integers', 400);
          const limit = Math.max(1, Math.min(Number(limitText), 500)), offset = Math.max(0, Number(offsetText));
          const filters = Object.fromEntries(['kind', 'route', 'repo', 'number', 'status', 'provider', 'action', 'delivery_id'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]));
          const events = await store.recent(limit + 1, offset, filters);
          return jsonResponse({ ok: true, count: Math.min(events.length, limit), events: events.slice(0, limit), offset, has_more: events.length > limit });
        }
        if (path.startsWith('/api/events/')) {
          const detail = await store.detail(decodeURIComponent(path.slice('/api/events/'.length)));
          return detail ? jsonResponse({ ok: true, ...detail }) : fail('delivery not found', 404);
        }
        if (path === '/favicon.ico') return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && path.startsWith('/api/replay/')) {
        if (request.headers.get('x-requested-with') !== 'sciencediscovery-bot') return fail('admin writes need X-Requested-With: sciencediscovery-bot', 403);
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).host !== (request.headers.get('host') || url.host)) return fail('cross-origin admin write refused', 403);
        return await this.replay(decodeURIComponent(path.slice('/api/replay/'.length)));
      }
      return fail('not found', 404);
    } catch { return fail('storage unavailable', 503); }
  }
  private async replay(identifier: string): Promise<Response> {
    const store = this.pipeline.store, record = await store.find(identifier);
    if (!record) return jsonResponse({ ok: false, error: 'delivery not found' }, 404);
    const provider = string(record.provider), body = await store.payload(record);
    if (!['github', 'gitcode'].includes(provider) || body === null || record.body_complete === false) return jsonResponse({ ok: false, error: 'no stored payload for this delivery' }, 409);
    const detail = await store.detail(string(record.record_id));
    const originalHeaders = new Headers(object(object(detail?.request).headers) as Record<string, string>);
    const headers = new Headers({ 'Content-Type': originalHeaders.get('content-type') || 'application/json', [`x-${provider}-event`]: string(record.raw_event), [`x-${provider}-delivery`]: `replay-${crypto.randomUUID()}` });
    if (this.pipeline.cfg.secrets[provider]) headers.set(provider === 'github' ? 'x-hub-signature-256' : 'x-gitcode-signature-256', await sign(body, this.pipeline.cfg.secrets[provider]));
    const reply = await this.pipeline.receive(headers, body, provider, { source: 'replay', method: 'POST', path: `/webhook/${provider}`, replayed_from: record.record_id });
    return jsonResponse({ ok: reply.status === 200, status: reply.status, record: reply.record }, reply.status);
  }
}
