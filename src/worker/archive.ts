import { exchange, withBody } from '../core/archive.js';
import { string, object, type Archive, type Doc, type Reply } from '../core/types.js';

const columns = ['delivery_id', 'provider', 'kind', 'route', 'repo', 'number', 'status', 'action'] as const;
type Row = Record<string, SqlStorageValue> & { record_id: string; detail_key: string; body_key: string };
type Keys = { seq: number; body_key: string; detail_key: string };

/** At most this many index rows (or orphan objects) are removed per retention run. */
export const PRUNE_BATCH = 200;
const DAY_MS = 86400000;
const KEY_DAY = /^(?:payloads|deliveries)\/(\d{4}-\d{2}-\d{2})\//;
const ROOTS = ['payloads/', 'deliveries/'] as const;
/** Objects are filed under the UTC day of receipt; that day is what expires. */
const keyDay = (key: string): string | null => KEY_DAY.exec(key)?.[1] ?? null;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** counters holds integers, so days are stored as YYYYMMDD. */
const dayNumber = (day: string): number => Number(day.replaceAll('-', ''));
const dayText = (n: number): string => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
export interface PruneResult { status: 'idle' | 'busy' | 'backlog' | 'day' | 'orphans' | 'clean'; day?: string; rows?: number; objects?: number }

/** R2 holds complete bodies/exchanges; SQLite indexes stay small and queryable. */
export class WorkerArchive implements Archive {
  readonly sql: SqlStorage;
  private pruning = false;
  constructor(readonly storage: DurableObjectStorage, readonly bucket: R2Bucket, readonly window: number, readonly commitPending: () => void, readonly retentionDays = 60) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT UNIQUE NOT NULL, detail_key TEXT NOT NULL, body_key TEXT NOT NULL,
      delivery_id TEXT, provider TEXT, kind TEXT, route TEXT, repo TEXT, number TEXT, status TEXT, action TEXT, duplicate INTEGER);
      CREATE INDEX IF NOT EXISTS delivery_lookup ON deliveries(delivery_id, seq);
      CREATE INDEX IF NOT EXISTS delivery_repo ON deliveries(repo, seq);
      CREATE TABLE IF NOT EXISTS seen (provider TEXT, delivery_id TEXT, seq INTEGER, PRIMARY KEY(provider, delivery_id));
      CREATE INDEX IF NOT EXISTS seen_order ON seen(seq);
      CREATE TABLE IF NOT EXISTS totals (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_days (day TEXT PRIMARY KEY, min_seq INTEGER NOT NULL, max_seq INTEGER NOT NULL);`);
    // Rows indexed before archive_days existed form a one-time backlog ending at this seq; MAX(seq) reads one row.
    if (!this.sql.exec("SELECT 1 FROM counters WHERE name='archive_backlog_end'").toArray().length)
      this.sql.exec("INSERT INTO counters VALUES ('archive_backlog_end', (SELECT COALESCE(MAX(seq), 0) FROM deliveries))");
    // Storage bills every row a query reads, so the window size is kept as a
    // counter instead of being recounted. Existing archives count it once.
    if (!this.sql.exec("SELECT 1 FROM counters WHERE name='seen'").toArray().length)
      this.sql.exec("INSERT INTO counters VALUES ('seen', (SELECT COUNT(*) FROM seen))");
  }
  private remembered(): number {
    return this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name='seen'").one().value;
  }
  seen(provider: string, delivery: string): boolean {
    return !!delivery && this.sql.exec('SELECT 1 FROM seen WHERE provider=? AND delivery_id=?', provider, delivery).toArray().length > 0;
  }
  async save(reply: Reply, headers: Headers, body: Uint8Array, context: Doc = {}): Promise<void> {
    const { record, detail } = exchange(reply, headers, body, context);
    const bodyKey = string(record.payload_file), detailKey = string(record.detail_file);
    // Commit the index only after both private objects exist. A crash before the
    // transaction can leave unindexed objects, but never an acknowledged missing body.
    await this.bucket.put(bodyKey, body);
    await this.bucket.put(detailKey, JSON.stringify({ record, ...detail }), { httpMetadata: { contentType: 'application/json' } });
    this.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO deliveries(record_id,detail_key,body_key,${columns.join(',')},duplicate) VALUES (${Array(12).fill('?').join(',')})`,
        string(record.record_id), detailKey, bodyKey, ...columns.map(key => String(record[key] ?? '').slice(0, 4096)), Number(!!record.duplicate));
      const seq = this.sql.exec<{ seq: number }>('SELECT last_insert_rowid() AS seq').one().seq;
      // One row per UTC day bounds the seqs that expire together, so retention never scans deliveries.
      const day = keyDay(bodyKey);
      if (day) this.sql.exec('INSERT INTO archive_days VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET min_seq=MIN(min_seq, excluded.min_seq), max_seq=MAX(max_seq, excluded.max_seq)', day, seq, seq);
      const increment = (table: string, key: string) => this.sql.exec(`INSERT INTO ${table}(name,value) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value=value+1`, key);
      increment('totals', string(record.status));
      if (record.duplicate) increment('totals', 'duplicate');
      if (record.status === 'accepted') {
        if (!record.duplicate) increment('routes', string(record.route).slice(0, 4096));
        if (record.delivery_id) {
          const known = this.seen(string(record.provider), string(record.delivery_id)), size = this.remembered();
          this.sql.exec('INSERT INTO seen VALUES (?,?,?) ON CONFLICT(provider,delivery_id) DO UPDATE SET seq=excluded.seq', string(record.provider), string(record.delivery_id), seq);
          // Keep the newest `window` deliveries. The seq index lets this read only
          // the rows it forgets rather than rescanning the whole window.
          const next = size + Number(!known);
          if (next > this.window) this.sql.exec('DELETE FROM seen WHERE rowid IN (SELECT rowid FROM seen ORDER BY seq LIMIT ?)', next - this.window);
          if (Math.min(next, this.window) !== size) this.sql.exec("UPDATE counters SET value=? WHERE name='seen'", Math.min(next, this.window));
        }
      }
      this.commitPending();
    });
    Object.assign(reply.record, record);
  }
  private async envelope(row: Row): Promise<Doc> {
    const blob = await this.bucket.get(row.detail_key);
    if (!blob) throw new Error('missing exchange');
    return object(await blob.json());
  }
  private row(identifier: string): Row | undefined {
    return this.sql.exec<Row>('SELECT * FROM deliveries WHERE record_id=?', identifier).toArray()[0]
      || this.sql.exec<Row>('SELECT * FROM deliveries WHERE delivery_id=? ORDER BY seq DESC LIMIT 1', identifier).toArray()[0];
  }
  async recent(limit: number, offset = 0, filters: Doc = {}): Promise<Doc[]> {
    const keys = columns.filter(key => filters[key] !== undefined && filters[key] !== '');
    const where = keys.map(key => `${key}=?${key === 'repo' ? ' COLLATE NOCASE' : ''}`);
    const rows = this.sql.exec<Row>(`SELECT * FROM deliveries${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ? OFFSET ?`,
      ...keys.map(key => String(filters[key])), limit, offset).toArray();
    return Promise.all(rows.map(async row => object((await this.envelope(row)).record)));
  }
  async find(identifier: string): Promise<Doc | null> {
    const row = this.row(identifier); return row ? object((await this.envelope(row)).record) : null;
  }
  async payload(record: Doc): Promise<Uint8Array | null> {
    const row = this.row(string(record.record_id));
    const blob = row ? await this.bucket.get(row.body_key) : null;
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
  async detail(identifier: string): Promise<Doc | null> {
    const row = this.row(identifier); if (!row) return null;
    const envelope = await this.envelope(row), record = object(envelope.record);
    return withBody(record, envelope, await this.payload(record));
  }
  private counter(name: string): number | null {
    return this.sql.exec<{ value: number }>('SELECT value FROM counters WHERE name=?', name).toArray()[0]?.value ?? null;
  }
  private setCounter(name: string, value: number): void {
    this.sql.exec('INSERT INTO counters(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', name, value);
  }
  /** R2 first: a crash leaves the index rows, so the same batch and its keys are found again. */
  private async forget(rows: Keys[]): Promise<void> {
    const keys = rows.flatMap(row => [row.body_key, row.detail_key]);
    for (let i = 0; i < keys.length; i += 1000) await this.bucket.delete(keys.slice(i, i + 1000));
  }
  private deleteRows(rows: Keys[]): void {
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      this.sql.exec(`DELETE FROM deliveries WHERE seq IN (${chunk.map(() => '?').join(',')})`, ...chunk.map(row => row.seq));
    }
  }
  /**
   * One bounded retention step: the R2 bodies/exchanges and deliveries rows of UTC days older than
   * `retentionDays` are removed. seen, totals, routes and other tables are never touched.
   * Once a run finds nothing to do, the rest of that UTC day reads only one counter row.
   */
  async prune(now = Date.now()): Promise<PruneResult> {
    if (this.pruning) return { status: 'busy' };
    this.pruning = true;
    try {
      const today = utcDay(now), cutoff = utcDay(now - this.retentionDays * DAY_MS);
      if (this.counter('archive_prune_day') === dayNumber(today)) return { status: 'idle' };
      if (this.counter('archive_backlog_done') !== 1) return await this.pruneBacklog(cutoff);
      const expired = this.sql.exec<{ day: string; min_seq: number; max_seq: number }>('SELECT day, min_seq, max_seq FROM archive_days WHERE day < ? ORDER BY day LIMIT 1', cutoff).toArray()[0];
      if (expired) return await this.pruneDay(expired, cutoff);
      const orphans = await this.pruneOrphans(cutoff);
      if (orphans) return orphans;
      this.setCounter('archive_prune_day', dayNumber(today));
      return { status: 'clean' };
    } finally { this.pruning = false; }
  }
  /** Rows from before archive_days: a forward-only cursor reads each one once, deletes the expired and indexes the rest. */
  private async pruneBacklog(cutoff: string): Promise<PruneResult> {
    const cursor = this.counter('archive_backlog_seq') ?? 0, end = this.counter('archive_backlog_end') ?? 0;
    const rows = this.sql.exec<Keys>('SELECT seq, body_key, detail_key FROM deliveries WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?', cursor, end, PRUNE_BATCH).toArray();
    const expired = rows.filter(row => { const day = keyDay(row.body_key); return !!day && day < cutoff; });
    await this.forget(expired);
    this.storage.transactionSync(() => {
      this.deleteRows(expired);
      for (const row of rows) {
        const day = keyDay(row.body_key);
        if (day && day >= cutoff) this.sql.exec('INSERT INTO archive_days VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET min_seq=MIN(min_seq, excluded.min_seq), max_seq=MAX(max_seq, excluded.max_seq)', day, row.seq, row.seq);
      }
      const last = rows.at(-1)?.seq ?? end;
      this.setCounter('archive_backlog_seq', last);
      if (rows.length < PRUNE_BATCH || last >= end) this.setCounter('archive_backlog_done', 1);
    });
    return { status: 'backlog', rows: expired.length, objects: expired.length * 2 };
  }
  /** The oldest expired day: at most one batch from its seq range, then the range shrinks or the day row goes. */
  private async pruneDay(expired: { day: string; min_seq: number; max_seq: number }, cutoff: string): Promise<PruneResult> {
    const rows = this.sql.exec<Keys>('SELECT seq, body_key, detail_key FROM deliveries WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?', expired.min_seq, expired.max_seq, PRUNE_BATCH).toArray();
    // The range holds that day's rows; anything filed under a later day is left to its own day row.
    const doomed = rows.filter(row => (keyDay(row.body_key) ?? expired.day) < cutoff);
    await this.forget(doomed);
    this.storage.transactionSync(() => {
      this.deleteRows(doomed);
      const next = (rows.at(-1)?.seq ?? expired.max_seq) + 1;
      if (rows.length < PRUNE_BATCH || next > expired.max_seq) this.sql.exec('DELETE FROM archive_days WHERE day=?', expired.day);
      else this.sql.exec('UPDATE archive_days SET min_seq=? WHERE day=?', next, expired.day);
    });
    return { status: 'day', day: expired.day, rows: doomed.length, objects: doomed.length * 2 };
  }
  /**
   * Objects without an index row (e.g. a crash between the R2 write and the index commit). Only the date
   * directories are listed; objects are listed and deleted only under expired dates, and only after every
   * indexed row of those dates is gone.
   */
  private async pruneOrphans(cutoff: string): Promise<PruneResult | null> {
    const swept = this.counter('archive_orphan_day') ?? 0;
    let target: string | null = null;
    for (const root of ROOTS) {
      const listed = await this.bucket.list({ prefix: root, delimiter: '/', ...(swept ? { startAfter: `${root}${dayText(swept)}/\uffff` } : {}) });
      for (const prefix of listed.delimitedPrefixes) {
        const day = keyDay(prefix);
        if (day && day < cutoff && (!target || day < target)) target = day;
      }
    }
    if (!target) {
      // Every date before the cutoff is clean; later lists start after it.
      const done = dayNumber(utcDay(Date.parse(cutoff) - DAY_MS));
      if (done > swept) this.setCounter('archive_orphan_day', done);
      return null;
    }
    let budget = PRUNE_BATCH, objects = 0, remaining = false;
    for (const root of ROOTS) {
      if (budget <= 0) { remaining = true; break; }
      const page = await this.bucket.list({ prefix: `${root}${target}/`, limit: budget });
      if (page.objects.length) await this.bucket.delete(page.objects.map(object => object.key));
      objects += page.objects.length; budget -= page.objects.length;
      if (page.truncated) remaining = true;
    }
    if (!remaining) this.setCounter('archive_orphan_day', dayNumber(target));
    return { status: 'orphans', day: target, objects };
  }
  async status(): Promise<Doc> {
    const counts: Doc = { accepted: 0, ignored: 0, rejected: 0, duplicate: 0 };
    for (const row of this.sql.exec<{ name: string; value: number }>('SELECT * FROM totals').toArray()) counts[row.name] = row.value;
    counts.by_route = Object.fromEntries(this.sql.exec<{ name: string; value: number }>('SELECT * FROM routes').toArray().map(row => [row.name, row.value]));
    return { counts, last: (await this.recent(1))[0] || null, remembered_deliveries: this.remembered() };
  }
}
