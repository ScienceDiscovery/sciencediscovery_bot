// Isolated Access stand-in: this server is never bundled into the deployed Worker.
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { workerRuntime } from '../tools/worker-runtime.mjs';
const issuer = 'https://browser-test.cloudflareaccess.com';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'browser-key', use: 'sig' };
const jwt = await new SignJWT({ sub: 'browser-user' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
  .setIssuer(issuer).setAudience('browser-admin').setIssuedAt().setExpirationTime('1h').sign(privateKey);
const mf = await workerRuntime({ directory: process.env.SDBOT_CLOUD_E2E_RUN_DIR, bindings: {
  SDBOT_GITHUB_WEBHOOK_SECRET: process.env.SDBOT_E2E_SECRET,
  SDBOT_ADMIN_HOSTNAME: '127.0.0.1', SDBOT_ACCESS_ISSUER: issuer, SDBOT_ACCESS_AUD: 'browser-admin', SDBOT_ENVIRONMENT: 'test',
}, outboundService: request => request.url === issuer + '/cdn-cgi/access/certs' ? Response.json({ keys: [jwk] }) : new Response(null, { status: 503 }) });
const server = createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    headers.delete('cf-access-jwt-assertion');
    if (headers.get('cookie')?.split(';').some(c => c.trim() === 'test_access=allowed')) headers.set('cf-access-jwt-assertion', jwt);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const response = await mf.dispatchFetch('http://127.0.0.1:18893' + req.url, { method: req.method, headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('test server error'); }
});
server.listen(18893, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { server.close(); await mf.dispose(); process.exit(0); });
