import type { Config } from '../core/config.js';
import { disabledSync, publicSyncConfig } from '../core/config.js';
import { LEASE_MS, SyncHub, dueOf, runDue, snapshotDoc, syncContext, type Lock, type PullState, type SyncContext, type SyncRecord, type SyncStore } from '../core/gitcode-sync.js';
import type { Doc } from '../core/types.js';

const MAX_RECORDS = 300;
/** SQLite rows in the bot's Durable Object; one row per pull request, bounded record history. */
export class WorkerSyncStore implements SyncStore {
  private ready = false;
  constructor(readonly storage: DurableObjectStorage) {}
  private get sql(): SqlStorage {
    if (!this.ready) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS gitcode_sync_pulls (pr INTEGER PRIMARY KEY, due INTEGER, updated INTEGER NOT NULL, state TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS gitcode_sync_due ON gitcode_sync_pulls(due);
        CREATE TABLE IF NOT EXISTS gitcode_sync_records (seq INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL);`);
      this.ready = true;
    }
    return this.storage.sql;
  }
  getSync(pr: number): PullState | null {
    const row = this.sql.exec<{ state: string }>('SELECT state FROM gitcode_sync_pulls WHERE pr=?', pr).toArray()[0];
    return row ? JSON.parse(row.state) as PullState : null;
  }
  putSync(state: PullState): void {
    this.sql.exec('INSERT INTO gitcode_sync_pulls VALUES (?,?,?,?) ON CONFLICT(pr) DO UPDATE SET due=excluded.due, updated=excluded.updated, state=excluded.state',
      state.pr, dueOf(state), state.updated, JSON.stringify(state));
  }
  async get(pr: number): Promise<PullState | null> { return this.getSync(pr); }
  async put(state: PullState): Promise<void> { this.putSync(state); }
  async claim(now: number, limit: number): Promise<PullState[]> {
    return this.storage.transactionSync(() => {
      const rows = this.sql.exec<{ state: string }>('SELECT state FROM gitcode_sync_pulls WHERE due IS NOT NULL AND due <= ? ORDER BY due LIMIT ?', now, limit).toArray();
      return rows.map(row => {
        const state = JSON.parse(row.state) as PullState;
        state.lease = now + LEASE_MS; this.putSync(state);
        return state;
      });
    });
  }
  async next(): Promise<number | null> {
    return this.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM gitcode_sync_pulls WHERE due IS NOT NULL').one().due ?? null;
  }
  async append(records: SyncRecord[]): Promise<void> {
    this.storage.transactionSync(() => {
      for (const record of records) this.sql.exec('INSERT INTO gitcode_sync_records(record) VALUES (?)', JSON.stringify(record));
      this.sql.exec('DELETE FROM gitcode_sync_records WHERE seq <= (SELECT MAX(seq) FROM gitcode_sync_records) - ?', MAX_RECORDS);
    });
  }
  async records(limit: number): Promise<SyncRecord[]> {
    return this.sql.exec<{ record: string }>('SELECT record FROM gitcode_sync_records ORDER BY seq DESC LIMIT ?', limit).toArray().map(row => JSON.parse(row.record) as SyncRecord);
  }
  async pulls(limit: number): Promise<PullState[]> {
    return this.sql.exec<{ state: string }>('SELECT state FROM gitcode_sync_pulls ORDER BY updated DESC LIMIT ?', limit).toArray().map(row => JSON.parse(row.state) as PullState);
  }
  /** Searches every row, not the recent window the dashboard reads. */
  byHeadSync(sha: string): PullState[] {
    return this.sql.exec<{ state: string }>("SELECT state FROM gitcode_sync_pulls WHERE json_extract(state, '$.head_sha') = ?", sha).toArray().map(row => JSON.parse(row.state) as PullState);
  }
  byMergeRequestSync(mr: number): PullState[] {
    return this.sql.exec<{ state: string }>("SELECT state FROM gitcode_sync_pulls WHERE json_extract(state, '$.mr.number') = ?", mr).toArray().map(row => JSON.parse(row.state) as PullState);
  }
}

/**
 * Transactional outbox like the board: the listener stages in memory and the
 * archive commit writes the staged state in the same SQLite transaction.
 */
export class WorkerGitCodeSync extends SyncHub {
  readonly store: WorkerSyncStore;
  private readonly pending = new Map<number, PullState>();
  constructor(storage: DurableObjectStorage, cfg: Config, private readonly context: () => SyncContext = () => syncContext(cfg)) {
    super(cfg); this.store = new WorkerSyncStore(storage);
  }
  // Webhook handling already runs inside the Durable Object's ingestion mutex.
  protected transaction<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  protected async current(pr: number): Promise<PullState | null> {
    const staged = this.pending.get(pr);
    return staged ? structuredClone(staged) : this.store.getSync(pr);
  }
  protected async stage(state: PullState): Promise<void> { this.pending.set(state.pr, structuredClone(state)); }
  protected async byHead(sha: string): Promise<PullState[]> {
    const staged = [...this.pending.values()].filter(state => state.head_sha === sha).map(state => structuredClone(state));
    return [...staged, ...this.store.byHeadSync(sha).filter(state => !this.pending.has(state.pr))];
  }
  protected async byMergeRequest(mr: number): Promise<PullState[]> {
    const staged = [...this.pending.values()].filter(state => state.mr?.number === mr).map(state => structuredClone(state));
    return [...staged, ...this.store.byMergeRequestSync(mr).filter(state => !this.pending.has(state.pr))];
  }
  commitPending(): void { for (const state of this.pending.values()) this.store.putSync(state); this.pending.clear(); }
  clearPending(): void { this.pending.clear(); }
  async next(): Promise<number | null> {
    if (this.mode !== 'active') return null;
    const due = await this.store.next();
    return this.pending.size ? Math.min(due ?? Infinity, Date.now() + 1000) : due;
  }
  run(lock: Lock, now = Date.now()): Promise<number> { return runDue(this.store, lock, this.context, now); }
  async status(): Promise<Doc> {
    if (this.mode !== 'active') return disabledSync(this.disabledReasons);
    return { ...publicSyncConfig(this.config.gitcode_sync), next_due: await this.store.next() };
  }
  async snapshot(limit = 100): Promise<Doc> {
    if (this.mode !== 'active') return { ok: true, ...disabledSync(this.disabledReasons), records: [], pulls: [] };
    return snapshotDoc(this.config.gitcode_sync, await this.store.records(limit), await this.store.pulls(50));
  }
}
