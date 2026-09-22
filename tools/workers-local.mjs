import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseArgs, parseEnv } from 'node:util';
import { workerRuntime } from './worker-runtime.mjs';

const { values } = parseArgs({ options: {
  env: { type: 'string', default: '.dev.vars' }, state: { type: 'string', default: '.wrangler/local' },
  port: { type: 'string', default: '18891' }, 'admin-port': { type: 'string', default: '18892' }, 'allow-github': { type: 'boolean', default: false },
} });
const ports = [Number(values.port), Number(values['admin-port'])];
if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535 || [4310, 4311, 8791, 8792].includes(p)) || ports[0] === ports[1]) throw new Error('choose distinct local test ports');
const bindings = parseEnv(await readFile(values.env, 'utf8'));
bindings.SDBOT_WEBHOOK_PORT = String(ports[0]);
bindings.SDBOT_ADMIN_PORT = String(ports[1]);
const outboundService = values['allow-github'] ? request => {
  const url = new URL(request.url);
  if (url.origin !== 'https://api.github.com') return new Response(null, { status: 403 });
  return fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, duplex: 'half', redirect: 'error' });
} : undefined;
const mf = await workerRuntime({ directory: values.state, bindings, outboundService, port: ports[0] });
const admin = await mf.getWorker('admin');
const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
  const handle = async () => {
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const response = await admin.fetch(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method, headers: Object.fromEntries(headers),
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
  handle().catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); });
});
try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ports[1], '127.0.0.1', resolve); }); }
catch (error) { await mf.dispose(); throw error; }
console.log(`Workers local: http://127.0.0.1:${ports[0]} · admin http://127.0.0.1:${ports[1]} · GitHub network ${values['allow-github'] ? 'enabled' : 'blocked'}`);
let closing = false;
const close = async () => { if (closing) return; closing = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mf.dispose(); };
process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
