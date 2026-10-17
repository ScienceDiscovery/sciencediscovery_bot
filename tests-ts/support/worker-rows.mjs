// Measures SQLite rows read/written around the real Durable Object; test bundle only.
import worker, { BotObject as Original } from '../../src/worker/index.ts';
import { OBJECT_NAME } from '../../src/worker/env.ts';
import { unavailable } from '../../src/worker/failure.ts';

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
  // Rewrites stored callers as they were saved before permissions were configurable.
  legacyCallers() {
    const sql = this.ctx.storage.sql;
    for (const row of sql.exec('SELECT id, doc FROM caller_clients').toArray()) {
      const { permissions: _permissions, ...doc } = JSON.parse(row.doc);
      sql.exec('UPDATE caller_clients SET doc = ? WHERE id = ?', JSON.stringify(doc), row.id);
    }
    this.callers.cache = null;
  }
  // The single Actions entry's table as the previous version left it, written before any rule is read.
  legacyActionsPermissions(doc) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS token_permissions (id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO token_permissions VALUES ('actions', ?)", doc);
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
    // An object still on the previous code has no new RPC method; the real runtime's error must be recognized.
    if (url.pathname === '/_test/missing-rpc') { try { await stub.methodFromTheNextVersion(); return new Response('unexpected'); } catch (error) { return unavailable(error, request); } }
    if (url.pathname === '/_test/broken') return unavailable(new Error('secret=hunter22 went wrong'), request);
    if (url.pathname === '/_test/legacy-actions-permissions') return Response.json(await stub.legacyActionsPermissions(url.searchParams.get('doc')) ?? null);
    if (url.pathname === '/_test/legacy-callers') return Response.json(await stub.legacyCallers() ?? null);
    if (url.pathname === '/_test/claim') return Response.json(await stub.claimCredential(url.searchParams.get('key'), Number(url.searchParams.get('expires'))));
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
