import { DurableObject } from 'cloudflare:workers';
import { BotApplication, jsonResponse } from '../core/http.js';
import { Pipeline } from '../core/pipeline.js';
import { Router } from '../core/bus.js';
import { GitHubApp } from '../core/github-app.js';
import { dispatchCollection } from '../core/actions.js';
import { Mutex } from '../core/types.js';
import { WorkerArchive } from './archive.js';
import { WorkerBoard } from './board.js';
import { OBJECT_NAME, workerConfig, type WorkerEnv } from './env.js';

export class BotObject extends DurableObject<WorkerEnv> {
  private readonly mutex = new Mutex();
  private readonly app: BotApplication;
  private readonly board: WorkerBoard;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    const cfg = workerConfig(env);
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
    try { return await env.BOT.getByName(OBJECT_NAME).fetch(request); }
    catch { return jsonResponse({ ok: false, error: 'service unavailable' }, 503); }
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await env.BOT.getByName(OBJECT_NAME).wake();
  },
};
