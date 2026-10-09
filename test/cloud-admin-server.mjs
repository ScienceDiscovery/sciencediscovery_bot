// Isolated Access stand-in: this server is never bundled into the deployed Worker.
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from 'jose';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { ANALYTICS, analyticsService } from '../tests-ts/support/cloudflare-graphql.mjs';
const issuer = 'https://browser-test.cloudflareaccess.com';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'browser-key', use: 'sig' };
const jwt = await new SignJWT({ sub: 'browser-user' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
  .setIssuer(issuer).setAudience('browser-admin').setIssuedAt().setExpirationTime('1h').sign(privateKey);
// Account analytics come from a local stand-in with fixed month-to-date values.
const analytics = analyticsService();
// A throwaway GitHub App key; installation tokens come from the stand-in below, never from GitHub.
const app = await generateKeyPair('RS256', { extractable: true });
const github = request => {
  const url = new URL(request.url);
  if (url.hostname !== 'api.github.com') return null;
  if (url.pathname.endsWith('/installation')) return Response.json({ id: 7 });
  if (url.pathname === '/app/installations/7/access_tokens') return Response.json({ token: 'ghs_browser-journey', expires_at: new Date(Date.now() + 3600000).toISOString() }, { status: 201 });
  return new Response(null, { status: 404 });
};
const mf = await workerRuntime({ directory: process.env.SDBOT_CLOUD_E2E_RUN_DIR, bindings: {
  SDBOT_GITHUB_WEBHOOK_SECRET: process.env.SDBOT_E2E_SECRET,
  SDBOT_ADMIN_HOSTNAME: '127.0.0.1', SDBOT_ACCESS_ISSUER: issuer, SDBOT_ACCESS_AUD: 'browser-admin', SDBOT_ENVIRONMENT: 'test',
  SDBOT_ANALYTICS_TOKEN: ANALYTICS.token, SDBOT_CLOUDFLARE_ACCOUNT_ID: ANALYTICS.account, SDBOT_ARCHIVE_BUCKET: ANALYTICS.bucket,
  SDBOT_GITHUB_APP_ID: '321', SDBOT_GITHUB_APP_PRIVATE_KEY: await exportPKCS8(app.privateKey),
}, outboundService: request => request.url === issuer + '/cdn-cgi/access/certs' ? Response.json({ keys: [jwk] }) : github(request) || analytics.handler(request) });
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
