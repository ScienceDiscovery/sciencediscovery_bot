/// <reference types="@cloudflare/workers-types" />
import { decodeJwt, importX509, jwtVerify } from 'jose';
import { CALLER_AUDIENCE, CALLER_CLOCK_TOLERANCE, CALLER_LIMIT, CALLER_MAX_TOKEN_SECONDS, CALLER_RATE_PER_MINUTE, CALLER_TOKEN_PATH,
  authorizeRepo, parseClient, parseTokenRequest, publicClient, type CallerClient, type Refusal } from '../core/caller.js';
import { CALLER_PERMISSIONS, GitHubApp } from '../core/github-app.js';
import { jsonResponse } from '../core/http.js';
import { OBJECT_NAME, workerConfig, type WorkerEnv } from './env.js';
import type { AdminReply } from './forward.js';
import { describePermissions } from './token-grants.js';

const CLIENT_ID = /^[0-9a-f-]{36}$/;

/** Clients, single-use token ids and the per-minute counter, in the bot's Durable Object. */
export class WorkerCallers {
  private cache: CallerClient[] | null = null;
  constructor(readonly storage: DurableObjectStorage) {}
  /** Tables are created on first use; the client list is then served from memory. */
  private get sql(): SqlStorage {
    if (!this.cache) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS caller_clients (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS caller_tokens (client TEXT NOT NULL, jti TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (client, jti));
        CREATE INDEX IF NOT EXISTS caller_tokens_expiry ON caller_tokens(expires);
        CREATE TABLE IF NOT EXISTS caller_rate (client TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
        DROP TABLE IF EXISTS caller_audit;`);
      this.cache = this.storage.sql.exec<{ doc: string }>('SELECT doc FROM caller_clients').toArray()
        // Clients saved by the earlier on-behalf API carried an operations list; it no longer applies.
        .map(row => { const { operations: _operations, ...client } = JSON.parse(row.doc) as CallerClient & { operations?: unknown }; return client; })
        .sort((a, b) => a.created.localeCompare(b.created));
    }
    return this.storage.sql;
  }
  private clients(): CallerClient[] { return this.sql && this.cache!; }
  client(id: string): CallerClient | null { return this.clients().find(client => client.id === id) || null; }
  /**
   * Spends a token id and one unit of the client's per-minute allowance in one transaction.
   * Ids are kept until their token expires, so a replay inside the lifetime is refused.
   */
  claim(id: string, jti: string, expires: number, now = Date.now()): 'ok' | 'replay' | 'rate' {
    const sql = this.sql;
    return this.storage.transactionSync(() => {
      sql.exec('DELETE FROM caller_tokens WHERE expires < ?', Math.floor(now / 1000));
      if (sql.exec('SELECT 1 FROM caller_tokens WHERE client=? AND jti=?', id, jti).toArray().length) return 'replay';
      sql.exec('INSERT INTO caller_tokens VALUES (?, ?, ?)', id, jti, expires + CALLER_CLOCK_TOLERANCE);
      const window = Math.floor(now / 60000), row = sql.exec<{ window: number; count: number }>('SELECT window, count FROM caller_rate WHERE client=?', id).toArray()[0];
      const count = row && row.window === window ? row.count : 0;
      if (count >= CALLER_RATE_PER_MINUTE) return 'rate';
      sql.exec('INSERT INTO caller_rate VALUES (?, ?, ?) ON CONFLICT(client) DO UPDATE SET window=excluded.window, count=excluded.count', id, window, count + 1);
      return 'ok';
    });
  }
  async admin(method: string, id: string | null, input: unknown): Promise<AdminReply> {
    const clients = this.clients(), index = id ? clients.findIndex(client => client.id === id) : -1;
    if (method === 'GET' && !id) {
      return { status: 200, body: { ok: true, limit: CALLER_LIMIT, audience: CALLER_AUDIENCE, rate_per_minute: CALLER_RATE_PER_MINUTE,
        max_token_seconds: CALLER_MAX_TOKEN_SECONDS, endpoint: CALLER_TOKEN_PATH, permissions: describePermissions(CALLER_PERMISSIONS), clients: clients.map(publicClient) } };
    }
    if (id && index < 0) return { status: 404, body: { ok: false, error: 'client not found' } };
    if (method === 'DELETE' && id) {
      this.sql.exec('DELETE FROM caller_clients WHERE id=?', id);
      clients.splice(index, 1);
      return { status: 200, body: { ok: true } };
    }
    if (method === 'POST' && !id || method === 'PUT' && id) {
      const parsed = await parseClient(input);
      if (!parsed.ok) return { status: 422, body: { ok: false, error: parsed.error } };
      if (!id && clients.length >= CALLER_LIMIT) return { status: 422, body: { ok: false, error: `at most ${CALLER_LIMIT} clients` } };
      const now = new Date().toISOString();
      const client: CallerClient = id ? { ...clients[index], ...parsed.value, updated: now } : { id: crypto.randomUUID(), ...parsed.value, created: now, updated: now };
      this.sql.exec('INSERT INTO caller_clients VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc', client.id, JSON.stringify(client));
      if (id) clients[index] = client; else clients.push(client);
      return { status: id ? 200 : 201, body: { ok: true, client: publicClient(client) } };
    }
    return { status: 405, body: { ok: false, error: 'method not allowed' } };
  }
}

const refuse = (refusal: Refusal, headers?: Headers) => jsonResponse({ ok: false, error: refusal.error }, refusal.status, headers);
const unauthorized = (error = 'unauthorized') => refuse({ status: 401, error }, new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' }));

/**
 * POST /caller/v1/token: a GitHub installation token for one repository, with issues and
 * pull_requests write only. Deliberately outside Cloudflare Access and never a webhook: the caller
 * proves itself with a JWT signed by the private key behind its registered certificate.
 */
export async function handleCaller(request: Request, env: WorkerEnv, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<Response> {
  if (new URL(request.url).pathname !== CALLER_TOKEN_PATH) return jsonResponse({ ok: false, error: 'not found' }, 404);
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method not allowed' }, 405, new Headers({ Allow: 'POST', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token || token.length > 16384) return unauthorized();
  let id: string;
  try { id = String(decodeJwt(token).iss || ''); } catch { return unauthorized(); }
  if (!CLIENT_ID.test(id)) return unauthorized();
  const bot = env.BOT.getByName(OBJECT_NAME);
  const client = await bot.callerClient(id) as CallerClient | null;
  if (!client) return unauthorized();
  const now = Date.now();
  // The certificate must be valid now; the private key never reaches the bot.
  if (now + CALLER_CLOCK_TOLERANCE * 1000 < Date.parse(client.not_before) || now - CALLER_CLOCK_TOLERANCE * 1000 > Date.parse(client.not_after)) return unauthorized('certificate is not within its validity period');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, await importX509(client.certificate, client.alg), { issuer: id, subject: id, audience: CALLER_AUDIENCE,
      algorithms: [client.alg], requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti'], clockTolerance: CALLER_CLOCK_TOLERANCE, currentDate: new Date(now) }));
  } catch { return unauthorized(); }
  const jti = payload.jti, exp = payload.exp!, iat = payload.iat!;
  if (typeof jti !== 'string' || !jti || jti.length > 128 || exp - iat > CALLER_MAX_TOKEN_SECONDS || iat > now / 1000 + CALLER_CLOCK_TOLERANCE) return unauthorized('token must be short-lived with a jti');
  const claimed = await bot.callerClaim(id, jti, exp);
  if (claimed === 'replay') return unauthorized('token id already used');
  if (claimed === 'rate') return refuse({ status: 429, error: `at most ${CALLER_RATE_PER_MINUTE} calls per minute` }, new Headers({ 'Content-Type': 'application/json', 'Retry-After': '60' }));
  if (Number(request.headers.get('content-length') || 0) > 4096) return refuse({ status: 422, error: 'request body is too large' });
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) return refuse({ status: 422, error: 'request body is too large' });
    input = JSON.parse(text);
  } catch { return refuse({ status: 422, error: 'body must be JSON' }); }
  const call = parseTokenRequest(input);
  if ('status' in call) return refuse(call);
  const cfg = workerConfig(env);
  const denied = authorizeRepo(client, call.repo, cfg);
  if (denied) return refuse(denied);
  if (!cfg.github_app_id || !cfg.github_app_private_key) return refuse({ status: 503, error: 'GitHub App credentials are not configured' });
  let grant;
  // GitHub refuses the token until the App's Issues and Pull requests write permissions are approved.
  try { grant = await new GitHubApp(cfg.github_app_id, cfg.github_app_private_key, fetcher).grantForCaller(call.repo); }
  catch { return refuse({ status: 503, error: 'GitHub did not issue a token with issues and pull_requests write for this repository' }); }
  // The record carries no token; failing to write it never withholds a token that was issued.
  try {
    await bot.recordTokenGrant({ issued_at: new Date().toISOString(), expires_at: grant.expires_at, source: 'caller', identity: id, repository: call.repo,
      purpose: null, permissions: describePermissions(CALLER_PERMISSIONS) });
  } catch { /* the grant list is informational */ }
  return jsonResponse({ token: grant.token, expires_at: grant.expires_at, repository: call.repo });
}
