// Test-only visibility into the existing outbox; never bundled for deployment.
import worker, { BotObject as Original } from '../../src/worker/index.ts';
import { WorkerRunChanges } from '../../src/worker/run-changes.ts';
import { OBJECT_NAME } from '../../src/worker/env.ts';
export class BotObject extends Original {
  async rerunState() {
    return { outbox: this.ctx.storage.sql.exec('SELECT state FROM board_outbox ORDER BY source').toArray().map(row => JSON.parse(row.state)),
      alarm: await this.ctx.storage.getAlarm() };
  }
  rollbackRerun() {
    const changes = new WorkerRunChanges(this.ctx.storage);
    const event = { repo: 'example/source', kind: 'workflow_run', action: 'completed',
      payload: { workflow_run: { id: 999001, run_attempt: 2, status: 'completed' } } };
    changes.stage(event);
    const before = changes.list(event.repo);
    try { this.ctx.storage.transactionSync(() => { changes.commitPending(); throw new Error('archive rollback'); }); } catch { /* expected */ }
    changes.clearPending(); changes.commitPending();
    return { before, after: changes.list(event.repo) };
  }
}
export default {
  async fetch(request, env, ctx) {
    const stub = env.BOT.getByName(OBJECT_NAME), path = new URL(request.url).pathname;
    if (path === '/_test/rerun-state') return Response.json(await stub.rerunState());
    if (path === '/_test/rerun-rollback') return Response.json(await stub.rollbackRerun());
    return worker.fetch(request, env, ctx);
  }, scheduled: worker.scheduled,
};
