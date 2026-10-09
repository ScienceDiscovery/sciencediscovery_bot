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
  // Simulates the passage of time for the one-row analytics cache.
  ageUsageCache(ms) { this.ctx.storage.sql.exec('UPDATE usage_cache SET fetched = fetched - ?', ms); }
  // Token records: seed in-process, count and find the oldest kept identity.
  seedGrants(count, issued, prefix) {
    for (let i = 0; i < count; i++) this.recordTokenGrant({ issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 3600000).toISOString(), source: 'actions',
      identity: `${prefix}-${i}`, repository: 'example/repo', purpose: 'source', permissions: 'metadata:read' });
  }
  grantCount() {
    const sql = this.ctx.storage.sql;
    const count = sql.exec('SELECT COUNT(*) AS n FROM token_grants').one().n, oldest = sql.exec('SELECT doc FROM token_grants ORDER BY seq LIMIT 1').toArray()[0];
    return { count, oldest: oldest ? JSON.parse(oldest.doc).identity : null };
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
    if (url.pathname === '/_test/usage') return Response.json(await stub.usage());
    if (url.pathname === '/_test/age-usage') return Response.json(await stub.ageUsageCache(Number(url.searchParams.get('ms'))) ?? null);
    if (url.pathname === '/_test/seed-grants') return Response.json(await stub.seedGrants(Number(url.searchParams.get('count')), Number(url.searchParams.get('issued')), url.searchParams.get('prefix')) ?? null);
    if (url.pathname === '/_test/grant-count') return Response.json(await stub.grantCount());
    if (url.pathname === '/_test/claim') return Response.json(await stub.claimCredential(url.searchParams.get('key'), Number(url.searchParams.get('expires'))));
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
