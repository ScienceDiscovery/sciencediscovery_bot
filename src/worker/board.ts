import { targets, type Config } from '../core/config.js';
import { category, type Board, type BotEvent, type Doc } from '../core/types.js';

interface DispatchState {
  source: string; repository: string; requested: number; dispatched: number;
  due: number; next_refresh: number; last_attempt: number; inflight: number;
  last_dispatch: string | null; error: string | null; retry: number;
}
/** Transactional outbox: only the archive commit makes staged refreshes durable. */
export class WorkerBoard implements Board {
  readonly mode: 'active' | 'noop';
  readonly repositories: string[];
  private readonly pending = new Set<string>();
  constructor(readonly storage: DurableObjectStorage, readonly cfg: Config, readonly clock = () => Date.now()) {
    this.repositories = Object.keys(targets(cfg)).map(source => source.toLowerCase());
    this.mode = this.repositories.length ? 'active' : 'noop';
    storage.sql.exec('CREATE TABLE IF NOT EXISTS board_outbox (source TEXT PRIMARY KEY, state TEXT NOT NULL)');
    for (const [source, repository] of Object.entries(targets(cfg))) {
      const old = this.get(source.toLowerCase());
      if (old && old.repository.toLowerCase() !== repository.toLowerCase()) throw new TypeError('persisted board destination differs from configuration');
      if (!old) this.put({ source, repository, requested: 0, dispatched: 0, due: 0, next_refresh: clock() + cfg.board_refresh * 1000, last_attempt: 0, inflight: 0, last_dispatch: null, error: null, retry: 30000 });
    }
  }
  private get(source: string): DispatchState | undefined {
    const row = this.storage.sql.exec<{ state: string }>('SELECT state FROM board_outbox WHERE source=?', source.toLowerCase()).toArray()[0];
    return row ? JSON.parse(row.state) as DispatchState : undefined;
  }
  private put(state: DispatchState): void {
    this.storage.sql.exec('INSERT INTO board_outbox VALUES (?,?) ON CONFLICT(source) DO UPDATE SET state=excluded.state', state.source.toLowerCase(), JSON.stringify(state));
  }
  private states(): DispatchState[] { return this.repositories.map(source => this.get(source)!); }
  async handle(method: string, event: BotEvent): Promise<Doc> {
    if (event.provider !== 'github' || !this.repositories.includes(event.repo.toLowerCase())) return { hook: 'board', method, status: this.mode === 'noop' ? 'noop' : 'ignored' };
    this.pending.add(event.repo.toLowerCase()); return { hook: 'board', method, status: 'queued' };
  }
  clearPending(): void { this.pending.clear(); }
  commitPending(): void {
    for (const source of this.pending) this.request(this.get(source)!);
    this.pending.clear();
  }
  private request(state: DispatchState): void {
    if (state.requested === state.dispatched) state.due = Math.max(this.clock() + this.cfg.board_debounce * 1000, state.last_attempt + 60000);
    state.requested++; this.put(state);
  }
  async schedule(): Promise<void> {
    const times = this.states().map(s => s.requested > s.dispatched ? s.due : s.next_refresh);
    // Before committing an archive, arm the alarm as well. The DO serializes
    // alarm claims against the transaction; Cron also repairs a failed alarm write.
    if (this.pending.size) times.push(this.clock() + this.cfg.board_debounce * 1000);
    if (times.length) await this.storage.setAlarm(Math.max(this.clock() + 100, Math.min(...times)));
  }
  claim(): DispatchState[] {
    const ready: DispatchState[] = [];
    for (const state of this.states()) {
      if (state.requested === state.dispatched && this.clock() >= state.next_refresh) this.request(state);
      if (state.requested > state.dispatched && this.clock() >= state.due) {
        state.inflight = state.requested; state.last_attempt = this.clock(); state.due = this.clock() + 120000;
        this.put(state); ready.push({ ...state });
      }
    }
    return ready;
  }
  finish(job: DispatchState, error?: unknown): void {
    const state = this.get(job.source)!;
    if (state.inflight !== job.inflight || state.last_attempt !== job.last_attempt) return;
    state.inflight = 0;
    if (error) {
      state.error = category(error); state.due = this.clock() + state.retry; state.retry = Math.min(state.retry * 2, 600000);
    } else {
      state.dispatched = job.inflight; state.last_dispatch = new Date(this.clock()).toISOString(); state.error = null; state.retry = 30000;
      state.next_refresh = this.clock() + this.cfg.board_refresh * 1000;
      state.due = Math.max(this.clock() + this.cfg.board_debounce * 1000, state.last_attempt + 60000);
    }
    this.put(state);
  }
  status(): Doc {
    return { enabled: this.mode === 'active', execution: 'github_actions', targets: this.states().map(s => ({ source: s.source, repository: s.repository,
      execution: 'github_actions', requested: s.requested, dispatched: s.dispatched, pending: s.requested > s.dispatched,
      running: !!s.inflight, last_dispatch: s.last_dispatch, error: s.error, last_success: null, commit: null })) };
  }
}
