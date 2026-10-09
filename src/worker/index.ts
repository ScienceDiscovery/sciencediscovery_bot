import { DurableObject } from 'cloudflare:workers';
import { BotApplication, jsonResponse } from '../core/http.js';
import { Pipeline } from '../core/pipeline.js';
import { Router } from '../core/bus.js';
import { GitHubApp } from '../core/github-app.js';
import { dispatchCollection } from '../core/actions.js';
import { Mutex, object } from '../core/types.js';
import { WorkerArchive, type PruneResult } from './archive.js';
import { WorkerBoard } from './board.js';
import { OBJECT_NAME, workerConfig, type WorkerEnv } from './env.js';
import { authorizeAdmin } from './access.js';
import { exchangeActionsToken, readGitCodeSync } from './actions-auth.js';
import { WorkerGitCodeSync } from './gitcode-sync.js';
import { AnalyticsCache } from './usage.js';
import { usageDocument } from '../core/usage.js';
import panel from '../../static/index.html';

export class BotObject extends DurableObject<WorkerEnv> {
  private readonly mutex = new Mutex();
  private readonly app: BotApplication;
  private readonly board: WorkerBoard;
  private readonly sync: WorkerGitCodeSync;
  private readonly archive: WorkerArchive;
  private analytics?: AnalyticsCache;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    const cfg = workerConfig(env);
    // The expiry index lets each exchange read only the claims it removes.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS credential_claims (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS credential_claims_expiry ON credential_claims(expires);`);
    this.board = new WorkerBoard(ctx.storage, cfg);
    this.sync = new WorkerGitCodeSync(ctx.storage, cfg);
    // Staged board refreshes and sync events commit in the same transaction as the archive index.
    const archive = this.archive = new WorkerArchive(ctx.storage, env.ARCHIVE, cfg.dedupe_window, () => { this.board.commitPending(); this.sync.commitPending(); }, cfg.archive_retention_days);
    const save = archive.save.bind(archive);
    archive.save = async (...args) => { await this.schedule(); await save(...args); };
    this.app = new BotApplication(new Pipeline(cfg, archive, new Router(this.board, this.sync)), async () => '');
  }
  /** One Durable Object alarm serves both queues: the earliest of their due times. */
  private async schedule(): Promise<void> {
    await this.board.schedule();
    const due = await this.sync.next();
    if (due === null) return;
    const at = Math.max(Date.now() + 100, due), current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }
  private async receive(request: Request, admin: boolean): Promise<Response> {
    return this.mutex.run(async () => {
      try { return admin ? await this.app.admin(request) : await this.app.webhook(request); }
      finally { this.board.clearPending(); this.sync.clearPending(); }
    });
  }
  fetch(request: Request): Promise<Response> { return this.receive(request, false); }
  // Namespace RPC only; the public fetch path never selects this method.
  admin(request: Request): Promise<Response> { return this.receive(request, true); }
  // Read-only RPC. The public management adapter authenticates before invoking it.
  // Queries do not acquire the ingestion mutex or schedule background work.
  query(path: string): Promise<Response> {
    return this.app.readAdmin(new Request('https://admin.internal' + path));
  }
  claimCredential(key: string, expires: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM credential_claims WHERE expires < ?', Math.floor(Date.now() / 1000) - 60);
      if (sql.exec('SELECT id FROM credential_claims WHERE id = ?', key).toArray().length) return false;
      // Keep a run's issuance guard for a day, including retries with a fresh OIDC JWT.
      sql.exec('INSERT INTO credential_claims VALUES (?, ?)', key, Math.max(expires, Math.floor(Date.now() / 1000) + 86400));
      return true;
    });
  }
  /**
   * Access-authenticated resource usage. Reads the database size and the maintained counters;
   * Cloudflare account analytics come from a one-row cache refreshed at most every six hours.
   * Never called by webhooks, alarms, health checks or token exchange.
   */
  async usage(): Promise<Record<string, unknown>> {
    const env = this.env, token = typeof env.SDBOT_ANALYTICS_TOKEN === 'string' ? env.SDBOT_ANALYTICS_TOKEN.trim() : '';
    const account = String(env.SDBOT_CLOUDFLARE_ACCOUNT_ID || '').trim(), bucket = String(env.SDBOT_ARCHIVE_BUCKET || '').trim();
    const local = this.archive.usage();
    let analytics: Record<string, unknown>;
    if (!token) analytics = { status: 'unconfigured', message: '未配置 Analytics token，不能估算操作量' };
    else if (!/^[0-9a-f]{32}$/.test(account) || !bucket) analytics = { status: 'unconfigured', message: '缺少 SDBOT_CLOUDFLARE_ACCOUNT_ID 或 SDBOT_ARCHIVE_BUCKET，不能查询云端计量' };
    else analytics = await (this.analytics ||= new AnalyticsCache(this.ctx.storage.sql)).read({ token, account, bucket, objectId: this.ctx.id.toString() });
    return usageDocument('cloudflare', local, analytics);
  }
  // Read-only RPC for the OIDC-authenticated dashboard collector.
  gitcodeSync(): Promise<Record<string, unknown>> { return this.sync.snapshot(); }
  async wake(): Promise<void> { await this.mutex.run(() => this.schedule()); }
  // Cron-driven retention step; bounded per call and independent of the ingestion mutex.
  pruneArchive(now?: number): Promise<PruneResult> { return this.archive.prune(now); }
  async alarm(): Promise<void> {
    const jobs = await this.mutex.run(async () => { const result = this.board.claim(); await this.schedule(); return result; });
    const dispatches = jobs.map(async job => {
      let error: unknown;
      try {
        const cfg = this.app.pipeline.cfg;
        await dispatchCollection(new GitHubApp(cfg.github_app_id, cfg.github_app_private_key), job.source, job.repository, job.inflight);
      } catch (caught) { error = caught; }
      await this.mutex.run(async () => { this.board.finish(job, error); await this.schedule(); });
    });
    // Sync work holds the mutex only to claim and to merge results, never across network calls.
    const sync = this.sync.mode === 'active' ? this.sync.run(fn => this.mutex.run(fn)).catch(() => 0) : Promise.resolve(0);
    await Promise.all([...dispatches, sync]);
    await this.mutex.run(() => this.schedule());
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/actions/token') return await exchangeActionsToken(request, env);
      if (url.pathname === '/actions/gitcode-sync') return await readGitCodeSync(request, env);
      if (url.pathname === '/actions' || url.pathname.startsWith('/actions/')) return jsonResponse({ ok: false, error: 'not found' }, 404);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        const denied = await authorizeAdmin(request, env);
        if (denied) return denied;
        if (request.method !== 'GET') return jsonResponse({ ok: false, error: 'method not allowed' }, 405, new Headers({ Allow: 'GET', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }));
        if (['/admin', '/admin/'].includes(url.pathname)) return new Response(panel, { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        } });
        const path = url.pathname.slice('/admin'.length);
        // Usage has its own RPC: it is requested by the usage section only, never by the 10-second refresh.
        if (path === '/api/usage') return jsonResponse({ ...object(await env.BOT.getByName(OBJECT_NAME).usage()), environment: env.SDBOT_ENVIRONMENT || 'unconfigured' });
        if (!['/api/status', '/api/listeners', '/api/events', '/api/gitcode-sync'].includes(path) && !path.startsWith('/api/events/')) return jsonResponse({ ok: false, error: 'not found' }, 404);
        const response = await env.BOT.getByName(OBJECT_NAME).query(path + url.search);
        if (path !== '/api/status' || !response.ok) return response;
        const status = object(await response.json()), config = object(status.config);
        delete config.webhook; delete config.admin; delete config.data_dir;
        return jsonResponse({ ...status, runtime: 'cloudflare', environment: env.SDBOT_ENVIRONMENT || 'unconfigured',
          build: (env.SDBOT_VERSION as { id?: string } | undefined)?.id || null });
      }
      return await env.BOT.getByName(OBJECT_NAME).fetch(request);
    }
    catch { return jsonResponse({ ok: false, error: 'service unavailable' }, 503); }
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const bot = env.BOT.getByName(OBJECT_NAME);
    await bot.wake();
    // A failed retention step is retried by the next cron; it never blocks queue scheduling.
    try { await bot.pruneArchive(controller.scheduledTime); } catch { console.error('archive retention step failed; retrying on the next cron'); }
  },
};
