import { DurableObject } from 'cloudflare:workers';
import { BotApplication, jsonResponse } from '../core/http.js';
import { Pipeline } from '../core/pipeline.js';
import { Router } from '../core/bus.js';
import { GitHubApp } from '../core/github-app.js';
import { dispatchCollection } from '../core/actions.js';
import { Mutex, object } from '../core/types.js';
import { WorkerArchive } from './archive.js';
import { WorkerBoard } from './board.js';
import { OBJECT_NAME, workerConfig, type WorkerEnv } from './env.js';
import { authorizeAdmin } from './access.js';
import { exchangeActionsToken } from './actions-auth.js';
import panel from '../../static/index.html';

export class BotObject extends DurableObject<WorkerEnv> {
  private readonly mutex = new Mutex();
  private readonly app: BotApplication;
  private readonly board: WorkerBoard;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    const cfg = workerConfig(env);
    // The expiry index lets each exchange read only the claims it removes.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS credential_claims (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS credential_claims_expiry ON credential_claims(expires);`);
    this.board = new WorkerBoard(ctx.storage, cfg);
    const archive = new WorkerArchive(ctx.storage, env.ARCHIVE, cfg.dedupe_window, () => this.board.commitPending());
    const save = archive.save.bind(archive);
    archive.save = async (...args) => { await this.board.schedule(); await save(...args); };
    this.app = new BotApplication(new Pipeline(cfg, archive, new Router(this.board)), async () => '');
  }
  private async receive(request: Request, admin: boolean): Promise<Response> {
    return this.mutex.run(async () => {
      try { return admin ? await this.app.admin(request) : await this.app.webhook(request); }
      finally { this.board.clearPending(); }
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
  async wake(): Promise<void> { await this.mutex.run(() => this.board.schedule()); }
  async alarm(): Promise<void> {
    const jobs = await this.mutex.run(async () => { const result = this.board.claim(); await this.board.schedule(); return result; });
    await Promise.all(jobs.map(async job => {
      let error: unknown;
      try {
        const cfg = this.app.pipeline.cfg;
        await dispatchCollection(new GitHubApp(cfg.github_app_id, cfg.github_app_private_key), job.source, job.repository, job.inflight);
      } catch (caught) { error = caught; }
      await this.mutex.run(async () => { this.board.finish(job, error); await this.board.schedule(); });
    }));
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/actions/token') return await exchangeActionsToken(request, env);
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
        if (!['/api/status', '/api/listeners', '/api/events'].includes(path) && !path.startsWith('/api/events/')) return jsonResponse({ ok: false, error: 'not found' }, 404);
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
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await env.BOT.getByName(OBJECT_NAME).wake();
  },
};
