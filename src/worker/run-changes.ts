/// <reference types="@cloudflare/workers-types" />
import { object, type BotEvent, type Doc } from '../core/types.js';

export const RUN_CHANGE_BATCH = 20;
export interface RunChange { id: number; attempt: number; revision: string }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const validRunChange = (value: unknown): value is RunChange => {
  const row = object(value);
  return Object.keys(row).length === 3 && positive(row.id) && positive(row.attempt) && row.attempt > 1
    && typeof row.revision === 'string' && /^[0-9a-f]{32}$/.test(row.revision);
};

/** Only unacknowledged reruns live here; normal completion never schedules another collection. */
export class WorkerRunChanges {
  private readonly staged = new Map<string, { source: string; id: number; attempt: number }>();
  private ready = false;
  constructor(readonly storage: DurableObjectStorage) {}
  private sql(): SqlStorage {
    if (!this.ready) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS board_run_changes (
        source TEXT NOT NULL, run_id INTEGER NOT NULL, attempt INTEGER NOT NULL, revision TEXT NOT NULL,
        PRIMARY KEY(source, run_id));
        CREATE TABLE IF NOT EXISTS board_run_cursor (source TEXT PRIMARY KEY, last_id INTEGER NOT NULL);`);
      this.ready = true;
    }
    return this.storage.sql;
  }
  stage(event: BotEvent): Doc {
    const run = object(event.payload.workflow_run);
    if (event.kind !== 'workflow_run' || event.action !== 'completed' || run.status !== 'completed'
      || !positive(run.id) || !positive(run.run_attempt) || run.run_attempt <= 1) return { status: 'ignored' };
    this.sql(); // Create the schema before the archive's transaction can roll back.
    const source = event.repo.toLowerCase(), key = `${source}:${run.id}`;
    if (run.run_attempt > (this.staged.get(key)?.attempt || 0)) this.staged.set(key, { source, id: run.id, attempt: run.run_attempt });
    return { status: 'deferred' };
  }
  clearPending(): void { this.staged.clear(); }
  /** Called inside the archive's SQLite transaction, after its R2 objects were saved. */
  commitPending(): void {
    for (const run of this.staged.values()) this.sql().exec(`INSERT INTO board_run_changes VALUES (?,?,?,?)
      ON CONFLICT(source, run_id) DO UPDATE SET attempt=excluded.attempt, revision=excluded.revision
      WHERE excluded.attempt > board_run_changes.attempt`, run.source, run.id, run.attempt, crypto.randomUUID().replaceAll('-', ''));
    this.staged.clear();
  }
  list(source: string): RunChange[] {
    source = source.toLowerCase();
    const sql = this.sql();
    return this.storage.transactionSync(() => {
      const cursor = sql.exec<{ last_id: number }>('SELECT last_id FROM board_run_cursor WHERE source=?', source).toArray()[0]?.last_id || 0;
      const select = (op: '>' | '<=', limit: number) => sql.exec<{ id: number; attempt: number; revision: string }>(
        `SELECT run_id AS id, attempt, revision FROM board_run_changes WHERE source=? AND run_id ${op} ? ORDER BY run_id LIMIT ?`, source, cursor, limit).toArray();
      const rows = select('>', RUN_CHANGE_BATCH);
      if (rows.length < RUN_CHANGE_BATCH) rows.push(...select('<=', RUN_CHANGE_BATCH - rows.length));
      // Rotate between small batches: a permanently failing run must not starve newer changes.
      if (rows.length) sql.exec('INSERT INTO board_run_cursor VALUES (?,?) ON CONFLICT(source) DO UPDATE SET last_id=excluded.last_id', source, rows.at(-1)!.id);
      return rows;
    });
  }
  ack(source: string, rows: RunChange[]): void {
    const sql = this.sql();
    this.storage.transactionSync(() => {
      for (const row of rows) sql.exec('DELETE FROM board_run_changes WHERE source=? AND run_id=? AND attempt=? AND revision=?',
        source.toLowerCase(), row.id, row.attempt, row.revision);
    });
  }
}
