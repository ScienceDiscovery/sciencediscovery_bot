import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BotApplication, VERSION, jsonResponse, type Capture } from '../core/http.js';
import { configFromEnv, targets, validateConfig, type Config } from '../core/config.js';
import { loadPrivateKey } from '../core/github-app.js';
import { Pipeline, rejected } from '../core/pipeline.js';
import { Router } from '../core/bus.js';
import { jsonBytes } from '../core/types.js';
import { FileArchive } from './archive.js';
import { responseHeaders } from '../core/archive.js';
import { createBoards } from './board.js';

function incomingHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  return headers;
}
async function readIncoming(req: IncomingMessage, maximum: number): Promise<Capture> {
  const declared = req.headers['content-length'] === undefined ? 0 : Number(req.headers['content-length']);
  const base: Capture = { body: new Uint8Array(), declared, complete: false, note: '' };
  if (req.headers['transfer-encoding']) return { ...base, error: { status: 400, message: 'unsupported transfer encoding' }, note: 'unsupported transfer encoding; body not read' };
  return new Promise(resolveCapture => {
    const chunks: Buffer[] = []; let total = 0, settled = false;
    const finish = (interrupted = false) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('sdbot:interrupted', onAbort);
      const result: Capture = { ...base, body: Buffer.concat(chunks), complete: !interrupted && total === declared && total <= maximum };
      if (declared > maximum || total > maximum) { result.error = { status: 413, message: 'payload too large' }; result.note = 'body exceeds request limit; only received prefix retained'; }
      else if (!result.complete) { result.error = { status: 400, message: 'incomplete body' }; result.note = 'incomplete request body'; }
      resolveCapture(result);
    };
    const onData = (chunk: Buffer) => {
      const room = maximum - total;
      if (room > 0) chunks.push(chunk.subarray(0, room));
      total += chunk.length;
      if (total > maximum || (declared > maximum && total >= maximum)) { req.pause(); finish(); }
    };
    const onEnd = () => finish(), onAbort = () => finish(true);
    const timer = setTimeout(() => { req.pause(); finish(true); }, 10000);
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onAbort); req.on('sdbot:interrupted', onAbort);
    if (req.readableEnded) finish();
  });
}
async function send(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(head ? undefined : Buffer.from(await response.arrayBuffer()));
}
export function listener(app: BotApplication, admin: boolean): Server {
  const active = new WeakMap<object, IncomingMessage>(), malformed = new WeakSet<object>();
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => {
    active.set(req.socket, req);
    const handle = async () => {
      const headers = incomingHeaders(req);
      const request = new Request(new URL(req.url || '/', `http://${headers.get('host') || 'localhost'}`), { method: req.method, headers });
      let response: Response;
      if (admin) { req.resume(); response = await app.admin(request); }
      else {
        const capture = await readIncoming(req, app.pipeline.cfg.max_body_bytes);
        response = await app.webhook(request, capture);
        if (!capture.complete) response.headers.set('Connection', 'close');
      }
      await send(res, response, req.method === 'HEAD');
    };
    void handle().catch(async () => { if (!res.headersSent) await send(res, jsonResponse({ ok: false, error: 'internal error' }, 500), false); else res.destroy(); })
      .finally(() => { active.delete(req.socket); });
  });
  server.on('clientError', (error, socket) => {
    if (malformed.has(socket)) return;
    malformed.add(socket);
    // An EOF framing error belongs to the request already being captured. Retain
    // that prefix and let its response boundary archive once, instead of losing it.
    const incoming = active.get(socket);
    if (incoming) { incoming.emit('sdbot:interrupted'); return; }
    const handle = async () => {
      const packet = (error as Error & { rawPacket?: Buffer }).rawPacket;
      const head = packet?.subarray(0, 16384).toString('latin1').split('\r\n\r\n')[0] || '';
      const [line = '', ...lines] = head.split('\r\n'), [method = 'POST', path = '/'] = line.split(' '), headers = new Headers();
      for (const value of lines) {
        const colon = value.indexOf(':');
        if (colon > 0) try { headers.append(value.slice(0, colon), value.slice(colon + 1).trim()); } catch { /* malformed header is not trusted */ }
      }
      let reply = rejected(headers, 400, 'bad request');
      if (!admin) {
        try { reply = await app.pipeline.receive(headers, new Uint8Array(), undefined, { source: 'webhook', method, path, body_complete: false, capture_note: 'invalid HTTP framing; body not read' }, reply); }
        catch { reply = rejected(headers, 503, 'storage unavailable'); }
      }
      if (socket.writable) {
        const body = jsonBytes(reply.body);
        const wireHeaders = [...(reply.headers || responseHeaders(reply.body))].map(([name, value]) => `${name}: ${value}`).join('\r\n');
        socket.end(`HTTP/1.1 ${reply.status} ${reply.status === 400 ? 'Bad Request' : 'Service Unavailable'}\r\n${wireHeaders}\r\nConnection: close\r\n\r\n${new TextDecoder().decode(body)}`);
      }
    };
    void handle().catch(() => socket.destroy());
  });
  return server;
}
export async function start(cfg: Config): Promise<{ app: BotApplication; webhook: Server; admin?: Server; close: () => Promise<void> }> {
  const problems = validateConfig(cfg);
  if (problems.length) throw new Error(problems.join('; '));
  const enabled = Object.keys(targets(cfg)).length > 0;
  if (enabled) {
    if (cfg.board_execution === 'local') await access(resolve(cfg.board_source_dir, 'publish.py'));
    if (cfg.github_app_id) await loadPrivateKey(cfg.github_app_private_key);
  }
  const board = enabled ? await createBoards(cfg) : undefined;
  const app = new BotApplication(new Pipeline(cfg, await FileArchive.open(cfg.data_dir, cfg.dedupe_window), new Router(board)), () => readFile(resolve(cfg.static_dir, 'index.html'), 'utf8'));
  const webhook = listener(app, false), admin = cfg.admin_enabled ? listener(app, true) : undefined;
  const listen = (server: Server, port: number, host: string) => new Promise<void>((done, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed); server.listen(port, host, () => { server.off('error', failed); done(); });
  });
  const closeServer = (server?: Server): Promise<void> => new Promise(done => { if (!server?.listening) return done(); server.close(() => done()); server.closeIdleConnections(); });
  try { await listen(webhook, cfg.webhook_port, cfg.webhook_host); if (admin) await listen(admin, cfg.admin_port, cfg.admin_host); }
  catch (error) { await closeServer(webhook); await closeServer(admin); throw error; }
  // Queue tasks run independently; a slow source never blocks webhook responses or the other board.
  const timers = board?.queues.map(queue => setInterval(() => { void queue.tick().catch(() => { console.error('board queue unavailable; retrying'); }); }, 1000)) || [];
  return { app, webhook, admin, close: async () => { timers.forEach(clearInterval); await Promise.all([closeServer(webhook), closeServer(admin)]); } };
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'webhook-host': { type: 'string' }, 'webhook-port': { type: 'string' }, 'admin-host': { type: 'string' }, 'admin-port': { type: 'string' }, 'data-dir': { type: 'string' }, 'no-admin': { type: 'boolean' } } });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const cfg = configFromEnv(process.env, root);
  for (const key of ['webhook-host', 'admin-host', 'data-dir'] as const) if (values[key]) cfg[key.replaceAll('-', '_') as 'webhook_host' | 'admin_host' | 'data_dir'] = values[key]!;
  for (const key of ['webhook-port', 'admin-port'] as const) if (values[key]) cfg[key.replaceAll('-', '_') as 'webhook_port' | 'admin_port'] = Number(values[key]);
  if (values['no-admin']) cfg.admin_enabled = false;
  const running = await start(cfg);
  for (const provider of ['github', 'gitcode']) if (!cfg.secrets[provider]) console.warn(`${provider}: unsigned mode; configure a webhook secret before public use`);
  console.log(`sciencediscovery-bot ${VERSION}: webhook :${cfg.webhook_port}; admin ${cfg.admin_enabled ? ':' + cfg.admin_port : 'disabled'}`);
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
    if (closing) return; closing = true;
    void running.close().finally(() => process.exit(0));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('refusing to start: check listener, storage and credential configuration'); process.exitCode = 2; });
}
