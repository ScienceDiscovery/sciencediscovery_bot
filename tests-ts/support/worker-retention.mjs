// Archive retention probes around the real Durable Object; test bundle only.
import worker, { BotObject as Original } from '../../src/worker/index.ts';
import { OBJECT_NAME } from '../../src/worker/env.ts';
import { WorkerSyncStore } from '../../src/worker/gitcode-sync.ts';

export class BotObject extends Original {
  constructor(ctx, env) {
    // Record every statement with its arguments and the rows it read, on the genuine SQL handle.
    const statements = [], sql = ctx.storage.sql, exec = sql.exec.bind(sql);
    sql.exec = (query, ...args) => { const cursor = exec(query, ...args); statements.push({ query, args, cursor }); return cursor; };
    super(ctx, env);
    this.statements = statements;
  }
  /** Statements since the previous call; cursors are complete once their statement returns. */
  usage() {
    const list = this.statements.map(({ query, args, cursor }) => ({ query: query.replace(/\s+/g, ' ').trim(), args, read: cursor.rowsRead, written: cursor.rowsWritten }));
    this.statements.length = 0;
    return { statements: list, read: list.reduce((n, s) => n + s.read, 0) };
  }
  /** Index rows as a release without archive_days wrote them, then mark them as the unscanned backlog (as an upgrade does). */
  async seedLegacy(days) {
    const sql = this.ctx.storage.sql;
    for (const [day, count] of days) for (let i = 0; i < count; i++) {
      const id = `${day}-${i}`, body = `payloads/${day}/${id}.body`, detail = `deliveries/${day}/${id}.json`;
      await this.env.ARCHIVE.put(body, 'body');
      await this.env.ARCHIVE.put(detail, JSON.stringify({ record: { record_id: id, received_at: `${day}T00:00:00.000Z`, status: 'accepted', route: 'issue.opened' } }));
      sql.exec("INSERT INTO deliveries(record_id,detail_key,body_key,delivery_id,provider,kind,route,repo,number,status,action,duplicate) VALUES (?,?,?,?,'github','issue','issue.opened','owner/repo','1','accepted','opened',0)", id, detail, body, id);
    }
    sql.exec("UPDATE counters SET value=(SELECT MAX(seq) FROM deliveries) WHERE name='archive_backlog_end'");
    sql.exec("DELETE FROM counters WHERE name IN ('archive_backlog_done','archive_backlog_seq','archive_prune_day')");
    this.usage();
  }
  async put(keys) { for (const key of keys) await this.env.ARCHIVE.put(key, 'orphan'); }
  async drop(keys) { await this.env.ARCHIVE.delete(keys); }
  async keys(prefix) {
    const keys = []; let cursor;
    do { const page = await this.env.ARCHIVE.list({ prefix, cursor }); keys.push(...page.objects.map(o => o.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
    return keys;
  }
  seedSync() {
    const store = new WorkerSyncStore(this.ctx.storage);
    store.putSync({ pr: 7, updated: 1, generation: 1, done: 1, next_try: 0, lease: 0, poll_due: null });
    return store.append([{ id: 'r1', time: '2026-01-01T00:00:00.000Z', pr: 7, action: 'opened', status: 'success' }]);
  }
  /** Table sizes and counters; read after usage() so they do not count as retention reads. */
  dump() {
    const sql = this.ctx.storage.sql, count = table => sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    const out = { deliveries: count('deliveries'), archive_days: sql.exec('SELECT * FROM archive_days ORDER BY day').toArray(), seen: count('seen'),
      credential_claims: count('credential_claims'), gitcode_sync_pulls: count('gitcode_sync_pulls'), gitcode_sync_records: count('gitcode_sync_records'),
      totals: Object.fromEntries(sql.exec('SELECT * FROM totals').toArray().map(r => [r.name, r.value])),
      routes: Object.fromEntries(sql.exec('SELECT * FROM routes').toArray().map(r => [r.name, r.value])),
      counters: Object.fromEntries(sql.exec('SELECT * FROM counters').toArray().map(r => [r.name, r.value])),
      days: Object.fromEntries(sql.exec('SELECT substr(body_key, 10, 10) AS day, COUNT(*) AS n FROM deliveries GROUP BY day').toArray().map(r => [r.day, r.n])) };
    this.statements.length = 0;
    return out;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), stub = env.BOT.getByName(OBJECT_NAME);
    if (url.pathname.startsWith('/_test/')) {
      const input = request.method === 'POST' ? await request.json() : {};
      const call = {
        'seed-legacy': () => stub.seedLegacy(input.days), put: () => stub.put(input.keys), drop: () => stub.drop(input.keys), keys: () => stub.keys(input.prefix),
        'seed-sync': () => stub.seedSync(), claim: () => stub.claimCredential(input.key, input.expires), prune: () => stub.pruneArchive(input.now),
        usage: () => stub.usage(), dump: () => stub.dump(),
      }[url.pathname.slice('/_test/'.length)];
      return Response.json(await call() ?? null);
    }
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
