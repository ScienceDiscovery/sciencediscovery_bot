// Measures SQLite rows read/written around the real Durable Object; test bundle only.
import worker, { BotObject as Original } from '../../src/worker/index.ts';
import { OBJECT_NAME } from '../../src/worker/env.ts';

export class BotObject extends Original {
  constructor(ctx, env) {
    // The runtime requires the genuine state object, so record cursors on its SQL handle.
    const cursors = [], sql = ctx.storage.sql, exec = sql.exec.bind(sql);
    sql.exec = (...args) => { const cursor = exec(...args); cursors.push(cursor); return cursor; };
    super(ctx, env);
    this.cursors = cursors;
  }
  // Totals since the previous call; cursors are complete once their statement returns.
  rows() {
    const totals = this.cursors.reduce((sum, cursor) => ({ read: sum.read + cursor.rowsRead, written: sum.written + cursor.rowsWritten }), { read: 0, written: 0 });
    this.cursors.length = 0;
    return totals;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), stub = env.BOT.getByName(OBJECT_NAME);
    if (url.pathname === '/_test/rows') return Response.json(await stub.rows());
    if (url.pathname === '/_test/claim') return Response.json(await stub.claimCredential(url.searchParams.get('key'), Number(url.searchParams.get('expires'))));
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
