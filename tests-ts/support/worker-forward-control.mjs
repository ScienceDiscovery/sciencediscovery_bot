// Test-only controls exercise the real alarm and archive without waiting 24 hours.
import worker, { BotObject as Original } from '../../src/worker/index.ts';
import { OBJECT_NAME } from '../../src/worker/env.ts';
export class BotObject extends Original {
  constructor(ctx, env) {
    const cursors = [], sql = ctx.storage.sql, exec = sql.exec.bind(sql);
    sql.exec = (...args) => {
      const cursor = exec(...args);
      cursors.push({ cursor, select: /^\s*SELECT/i.test(String(args[0])) });
      return cursor;
    };
    super(ctx, env);
    this.testNow = Date.now(); this.forwards.clock = () => this.testNow;
    this.cursors = cursors;
    const payload = this.forwards.payload;
    this.forwards.payload = async record => {
      if (this.holdPayload) await fetch('https://payload-gate.example/wait');
      return payload(record);
    };
  }
  rows() {
    const value = this.cursors.reduce((sum, { cursor, select }) => ({
      read: sum.read + cursor.rowsRead, written: sum.written + cursor.rowsWritten,
      select_read: sum.select_read + (select ? cursor.rowsRead : 0),
    }), { read: 0, written: 0, select_read: 0 });
    this.cursors.length = 0;
    return value;
  }
  async forwardTick(ms) { this.testNow += ms; await super.alarm(); }
  forwardJobs() { return this.forwards.retries().exec('SELECT due, doc FROM forward_retries ORDER BY due').toArray().map(row => ({ due: row.due, ...JSON.parse(row.doc) })); }
  async forwardDropBody(id) { const row = await this.archive.find(id); if (row) await this.env.ARCHIVE.delete(row.payload_file); }
  forwardExpire() {
    for (const row of this.forwards.retries().exec('SELECT id, doc FROM forward_retries').toArray()) {
      const doc = JSON.parse(row.doc); doc.expires = this.testNow;
      this.ctx.storage.sql.exec('UPDATE forward_retries SET doc=? WHERE id=?', JSON.stringify(doc), row.id);
    }
  }
  forwardSeed(sub) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS forward_subscriptions (id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO forward_subscriptions VALUES (?,?)', sub.id, JSON.stringify(sub));
    this.forwards.cache = null;
  }
  forwardSeedJob(job) { this.forwards.retries().exec('INSERT INTO forward_retries VALUES (?,?,?,?)', job.id, job.subscription, job.due, JSON.stringify(job)); }
  forwardHoldPayload(hold) { this.holdPayload = hold; }
  async probeAlarm(at) { if (at) await this.ctx.storage.setAlarm(at); return this.ctx.storage.getAlarm(); }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), stub = env.BOT.getByName(OBJECT_NAME);
    if (url.pathname === '/_test/forward-tick') return Response.json(await stub.forwardTick(Number(url.searchParams.get('ms'))) ?? null);
    if (url.pathname === '/_test/forward-jobs') return Response.json(await stub.forwardJobs());
    if (url.pathname === '/_test/drop-body') return Response.json(await stub.forwardDropBody(url.searchParams.get('id')) ?? null);
    if (url.pathname === '/_test/expire') return Response.json(await stub.forwardExpire() ?? null);
    if (url.pathname === '/_test/seed') return Response.json(await stub.forwardSeed(await request.json()) ?? null);
    if (url.pathname === '/_test/seed-job') return Response.json(await stub.forwardSeedJob(await request.json()) ?? null);
    if (url.pathname === '/_test/hold-payload') return Response.json(await stub.forwardHoldPayload(url.searchParams.get('value') === 'true') ?? null);
    if (url.pathname === '/_test/rows') return Response.json(await stub.rows());
    if (url.pathname === '/_test/alarm') return Response.json(await stub.probeAlarm(Number(url.searchParams.get('at'))));
    return worker.fetch(request, env, ctx);
  }, scheduled: worker.scheduled,
};
