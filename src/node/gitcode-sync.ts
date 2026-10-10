import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../core/config.js';
import { disabledSync, publicSyncConfig } from '../core/config.js';
import { LEASE_MS, SyncHub, dueOf, runDue, snapshotDoc, syncContext, type PullState, type SyncContext, type SyncRecord, type SyncStore } from '../core/gitcode-sync.js';
import { Mutex, object, type Doc } from '../core/types.js';

const MAX_RECORDS = 300;
interface FileDocument { pulls: Record<string, PullState>; records: SyncRecord[] }

/** Single JSON file, rewritten atomically; one bot process owns it. */
export class FileSyncStore implements SyncStore {
  private constructor(readonly path: string, private doc: FileDocument) {}
  static async open(path: string): Promise<FileSyncStore> {
    let doc: FileDocument = { pulls: {}, records: [] };
    try {
      const parsed = object(JSON.parse(await readFile(path, 'utf8')));
      doc = { pulls: object(parsed.pulls) as Record<string, PullState>, records: Array.isArray(parsed.records) ? parsed.records as SyncRecord[] : [] };
    } catch (error) { if (object(error).code !== 'ENOENT') throw error; }
    return new FileSyncStore(path, doc);
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp', file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(this.doc)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.path);
  }
  async get(pr: number): Promise<PullState | null> { return this.doc.pulls[pr] ? structuredClone(this.doc.pulls[pr]) : null; }
  async put(state: PullState): Promise<void> { this.doc.pulls[state.pr] = structuredClone(state); await this.persist(); }
  async claim(now: number, limit: number): Promise<PullState[]> {
    const ready = Object.values(this.doc.pulls).map(state => ({ state, due: dueOf(state) }))
      .filter(entry => entry.due !== null && entry.due <= now).sort((a, b) => a.due! - b.due!).slice(0, limit).map(entry => entry.state);
    for (const state of ready) state.lease = now + LEASE_MS;
    if (ready.length) await this.persist();
    return structuredClone(ready);
  }
  async next(): Promise<number | null> {
    const times = Object.values(this.doc.pulls).map(dueOf).filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }
  async append(records: SyncRecord[]): Promise<void> {
    this.doc.records.push(...structuredClone(records));
    if (this.doc.records.length > MAX_RECORDS) this.doc.records.splice(0, this.doc.records.length - MAX_RECORDS);
    await this.persist();
  }
  async records(limit: number): Promise<SyncRecord[]> { return structuredClone(this.doc.records.slice(-limit).reverse()); }
  async pulls(limit: number): Promise<PullState[]> { return structuredClone(Object.values(this.doc.pulls).sort((a, b) => b.updated - a.updated).slice(0, limit)); }
  async byHead(sha: string): Promise<PullState[]> { return structuredClone(Object.values(this.doc.pulls).filter(state => state.head_sha === sha)); }
  async byMergeRequest(mr: number): Promise<PullState[]> { return structuredClone(Object.values(this.doc.pulls).filter(state => state.mr?.number === mr)); }
}

export class NodeGitCodeSync extends SyncHub {
  private readonly mutex = new Mutex();
  private running = false;
  private constructor(cfg: Config, readonly store: FileSyncStore, private readonly context: () => SyncContext) { super(cfg); }
  static async open(cfg: Config, context: () => SyncContext = () => syncContext(cfg)): Promise<NodeGitCodeSync> {
    return new NodeGitCodeSync(cfg, await FileSyncStore.open(join(cfg.data_dir, 'gitcode-sync', 'state.json')), context);
  }
  protected transaction<T>(fn: () => Promise<T>): Promise<T> { return this.mutex.run(fn); }
  protected now(): number { return this.context().now(); }
  protected current(pr: number): Promise<PullState | null> { return this.store.get(pr); }
  protected stage(state: PullState): Promise<void> { return this.store.put(state); }
  protected byMergeRequest(mr: number): Promise<PullState[]> { return this.store.byMergeRequest(mr); }
  protected byHead(sha: string): Promise<PullState[]> { return this.store.byHead(sha); }
  /** Background queue step; overlapping timers are skipped, not queued. */
  async tick(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try { return await runDue(this.store, fn => this.mutex.run(fn), this.context, now); }
    finally { this.running = false; }
  }
  async status(): Promise<Doc> {
    if (this.mode !== 'active') return disabledSync(this.disabledReasons);
    const pulls = await this.store.pulls(1000);
    return { ...publicSyncConfig(this.config.gitcode_sync), tracked: pulls.length, pending: pulls.filter(p => p.generation > p.done || p.poll_due !== null).length, next_due: await this.store.next() };
  }
  async snapshot(limit = 100): Promise<Doc> {
    if (this.mode !== 'active') return { ok: true, ...disabledSync(this.disabledReasons), records: [], pulls: [] };
    return snapshotDoc(this.config.gitcode_sync, await this.store.records(limit), await this.store.pulls(50));
  }
}
