import { exchange, withBody } from '../core/archive.js';
import { string, object, type Archive, type Doc, type Reply } from '../core/types.js';

const columns = ['delivery_id', 'provider', 'kind', 'route', 'repo', 'number', 'status', 'action'] as const;
type Row = Record<string, SqlStorageValue> & { record_id: string; detail_key: string; body_key: string };

/** R2 holds complete bodies/exchanges; SQLite indexes stay small and queryable. */
export class WorkerArchive implements Archive {
  readonly sql: SqlStorage;
  constructor(readonly storage: DurableObjectStorage, readonly bucket: R2Bucket, readonly window: number, readonly commitPending: () => void) {
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
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
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
  async status(): Promise<Doc> {
    const counts: Doc = { accepted: 0, ignored: 0, rejected: 0, duplicate: 0 };
    for (const row of this.sql.exec<{ name: string; value: number }>('SELECT * FROM totals').toArray()) counts[row.name] = row.value;
    counts.by_route = Object.fromEntries(this.sql.exec<{ name: string; value: number }>('SELECT * FROM routes').toArray().map(row => [row.name, row.value]));
    return { counts, last: (await this.recent(1))[0] || null, remembered_deliveries: this.remembered() };
  }
}
