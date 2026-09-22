/** JSON is untrusted at the boundary. Adapters narrow objects before reading fields. */
export type Doc = Record<string, unknown>;
export const object = (value: unknown): Doc => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Doc : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const nullable = (value: unknown): unknown => value ?? null;
export const utf8 = new TextEncoder();
export const text = (value: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(value);
export const jsonBytes = (value: unknown): Uint8Array<ArrayBuffer> => utf8.encode(JSON.stringify(value));
export const nowISO = (): string => new Date().toISOString();
export const id = (): string => crypto.randomUUID().replaceAll('-', '');
export function category(error: unknown): string {
  // Do not expose arbitrary exception messages or custom names from business code.
  return error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error';
}
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
export interface BotEvent {
  provider: string; delivery_id: string; kind: string; action: string;
  repo: string; number: number | null; title: string; url: string; sender: string;
  merged: boolean; labels: string[]; ref: string; raw_event: string; raw_action: string;
  extra: Doc; payload: Doc;
}
export const routeOf = (event: BotEvent): string => event.kind === 'unknown' ? `unknown.${event.raw_event || '?'}` : event.kind + (event.action ? `.${event.action}` : '');
export function eventSummary(event: BotEvent): Doc {
  const { payload: _payload, ...summary } = event;
  return { ...summary, route: routeOf(event) };
}
export interface Outcome { handled: boolean; route: string; hooks: string[]; errors: string[]; listeners: Doc[]; duplicate: boolean; note: string; }
export function outcome(route: string, note = ''): Outcome {
  return { handled: false, route, hooks: [], errors: [], listeners: [], duplicate: false, note };
}
export interface Verification { ok: boolean; mode: string; reason: string; }
export interface Reply { status: number; body: Doc; record: Doc; headers?: Headers; }
export interface Archive {
  seen(provider: string, delivery: string): boolean | Promise<boolean>;
  save(reply: Reply, headers: Headers, body: Uint8Array, request?: Doc): Promise<void>;
  recent(limit: number, offset?: number, filters?: Doc): Promise<Doc[]>;
  find(identifier: string): Promise<Doc | null>;
  payload(record: Doc): Promise<Uint8Array | null>;
  detail(identifier: string): Promise<Doc | null>;
  status(): Doc | Promise<Doc>;
}
export interface Board {
  readonly mode: 'active' | 'noop';
  readonly repositories: readonly string[];
  handle(method: string, event: BotEvent): Promise<Doc>;
  status(): Doc;
}
