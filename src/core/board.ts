import { Mutex, category, nowISO, type Board, type BotEvent, type Doc } from './types.js';

export interface PublicationState { requested: number; completed: number; last_success: string | null; commit: string | null; error: string | null; last_dispatch?: string | null; }
export interface StateStore { load(): Promise<Partial<PublicationState>>; save(state: PublicationState): Promise<void>; }
export type Publisher = (generation: number) => Promise<string | { dispatched: true }>;
export class BoardQueue {
  private readonly mutex = new Mutex();
  private state: PublicationState = { requested: 0, completed: 0, last_success: null, commit: null, error: null };
  private running = false;
  private due = 0;
  private nextPeriodic = 0;
  private retryDelay = 30000;
  private lastAttempt = -Infinity;
  private constructor(readonly source: string, readonly repository: string, private readonly storage: StateStore, private readonly publish: Publisher,
    private readonly debounce: number, private readonly refresh: number, private readonly clock: () => number, readonly execution: 'local' | 'github_actions') {}
  static async open(source: string, repository: string, storage: StateStore, publish: Publisher, debounce = 20, refresh = 3600, clock = () => Date.now(), execution: 'local' | 'github_actions' = 'local'): Promise<BoardQueue> {
    const queue = new BoardQueue(source, repository, storage, publish, debounce * 1000, refresh * 1000, clock, execution);
    Object.assign(queue.state, await storage.load()); queue.due = clock() + debounce * 1000;
    if (!Number.isSafeInteger(queue.state.requested) || !Number.isSafeInteger(queue.state.completed) || queue.state.completed < 0 || queue.state.requested < queue.state.completed) throw new TypeError('invalid publication state');
    return queue;
  }
  status(): Doc { return { enabled: true, execution: this.execution, source: this.source, repository: this.repository, pending: this.state.requested > this.state.completed, running: this.running, ...this.state }; }
  async requestRefresh(): Promise<void> {
    await this.mutex.run(async () => {
      const pending = this.state.requested > this.state.completed;
      const next = { ...this.state, requested: this.state.requested + 1 };
      await this.storage.save(next); this.state = next;
      if (!pending) this.due = Math.max(this.clock() + this.debounce, this.lastAttempt + 60000);
    });
  }
  async tick(): Promise<void> {
    if (!this.running && this.state.requested === this.state.completed && this.clock() >= this.nextPeriodic) await this.requestRefresh();
    if (this.clock() >= this.due) await this.runOnce();
  }
  async runOnce(): Promise<boolean> {
    const generation = await this.mutex.run(async () => {
      if (this.running || this.state.requested <= this.state.completed) return null;
      this.running = true; this.lastAttempt = this.clock(); return this.state.requested;
    });
    if (generation === null) return false;
    try {
      const result = await this.publish(generation);
      if (this.execution === 'local' ? typeof result !== 'string' || !/^[0-9a-f]{40}$/.test(result) : typeof result !== 'object' || result.dispatched !== true) throw new TypeError('invalid publisher result');
      await this.mutex.run(async () => {
        const next = { ...this.state, completed: generation, error: null,
          ...(typeof result === 'string' ? { commit: result, last_success: nowISO() } : { commit: null, last_success: null, last_dispatch: nowISO() }) };
        await this.storage.save(next); this.state = next; this.retryDelay = 30000;
        this.due = Math.max(this.clock() + this.debounce, this.lastAttempt + 60000); this.nextPeriodic = this.clock() + this.refresh;
      });
    } catch (error) {
      await this.mutex.run(async () => {
        this.state.error = category(error); this.due = this.clock() + this.retryDelay; this.retryDelay = Math.min(this.retryDelay * 2, 600000);
        await this.storage.save(this.state);
      });
    } finally { this.running = false; }
    return true;
  }
}
export class MultiBoard implements Board {
  readonly mode = 'active' as const;
  readonly repositories: readonly string[];
  constructor(readonly queues: readonly BoardQueue[]) { this.repositories = queues.map(q => q.source.toLowerCase()); }
  async handle(method: string, event: BotEvent): Promise<Doc> {
    const queue = event.provider === 'github' ? this.queues.find(q => q.source.toLowerCase() === event.repo.toLowerCase()) : undefined;
    if (!queue) return { hook: 'board', method, status: 'ignored' };
    await queue.requestRefresh(); return { hook: 'board', method, status: 'queued' };
  }
  status(): Doc { return { enabled: true, targets: this.queues.map(q => q.status()) }; }
}
