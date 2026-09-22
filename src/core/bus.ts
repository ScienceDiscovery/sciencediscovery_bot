import { category, object, outcome, routeOf, type Board, type BotEvent, type Doc, type Outcome } from './types.js';
import { QUALITY_KINDS } from './events.js';

export interface Listener {
  id: string; business: string; description: string; routes: readonly string[];
  handler: (event: BotEvent) => Doc | void | Promise<Doc | void>;
  exclude?: readonly string[]; providers?: readonly string[]; repositories?: readonly string[];
  enabled?: boolean; mode?: 'active' | 'noop';
}
/** Shell-style route selectors, including ?, [abc], and [!abc]. No executable regex input. */
export function glob(value: string, pattern: string): boolean {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') regex += '.*';
    else if (c === '?') regex += '.';
    else if (c === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      const end = pattern.indexOf(']', i + 1);
      let content = pattern.slice(i + 1, end).replaceAll('\\', '\\\\');
      if (content.startsWith('!')) content = '^' + content.slice(1);
      else if (content.startsWith('^')) content = '\\' + content;
      regex += '[' + content + ']'; i = end;
    } else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(regex + '$', 's').test(value); } catch { return false; }
}
export class EventBus {
  private readonly listeners = new Map<string, Listener>();
  subscribe(listener: Listener): void {
    if (![listener.id, listener.business, listener.description].every(v => typeof v === 'string' && v.trim()) || !listener.routes?.length) throw new TypeError('listener requires metadata and routes');
    if (typeof listener.handler !== 'function' || !['active', 'noop'].includes(listener.mode || 'active')) throw new TypeError('invalid listener handler or mode');
    for (const values of [listener.routes, listener.exclude || [], listener.providers || [], listener.repositories || []]) {
      if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v)) throw new TypeError('invalid listener selectors');
    }
    if (this.listeners.has(listener.id)) throw new TypeError('duplicate listener id');
    this.listeners.set(listener.id, Object.freeze({ ...listener, routes: Object.freeze([...listener.routes]), exclude: Object.freeze([...(listener.exclude || [])]),
      providers: Object.freeze([...(listener.providers || [])]), repositories: Object.freeze([...(listener.repositories || [])]), enabled: listener.enabled ?? true, mode: listener.mode || 'active' }));
  }
  inventory(): Doc[] {
    return [...this.listeners.values()].map(({ handler: _handler, ...l }) => structuredClone({ ...l, mode: l.enabled ? l.mode : 'disabled' }));
  }
  async dispatch(event: BotEvent): Promise<Outcome> {
    const route = routeOf(event);
    const matching = [...this.listeners.values()].filter(l => l.enabled && l.routes.some(p => glob(route, p)) && !l.exclude!.some(p => glob(route, p)) &&
      (!l.providers!.length || l.providers!.includes(event.provider)) && (!l.repositories!.length || l.repositories!.some(r => r.toLowerCase() === event.repo.toLowerCase())));
    const result = outcome(route); result.handled = matching.length > 0;
    for (const listener of matching) {
      try {
        // Each subscriber owns its copy; a mutating extension cannot corrupt later consumers or the archive.
        const reply = await listener.handler(structuredClone(event));
        if (reply !== undefined && reply !== null && (typeof reply !== 'object' || Array.isArray(reply))) throw new TypeError('listener must return an object or undefined');
        if (reply?.hook && reply.method) result.hooks.push(`${reply.hook}.${reply.method}`);
        result.listeners.push({ id: listener.id, status: String(object(reply).status || 'ok') });
      } catch (error) {
        const kind = category(error);
        result.errors.push(`${listener.id}: ${kind}`); result.listeners.push({ id: listener.id, status: 'error', error: kind });
      }
    }
    return result;
  }
}
export class NoopBoard implements Board {
  readonly mode = 'noop' as const; readonly repositories: readonly string[] = [];
  async handle(method: string, _event: BotEvent): Promise<Doc> { return { hook: 'board', method, status: 'noop' }; }
  status(): Doc { return { enabled: false }; }
}
export function registerBuiltin(bus: EventBus, board: Board): void {
  const analyze: [string, string[], string][] = [
    ['on_issue', ['issue.opened', 'issue.edited', 'issue.reopened'], 'Issue 新建、编辑和重新打开的分析入口；当前仅记录调用。'],
    ['on_issue_comment', ['issue_comment', 'issue_comment.*'], 'Issue / PR 评论分析入口；当前仅记录调用。'],
    ['on_pull_request', ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'].map(a => `pull_request.${a}`), 'PR 变更分析入口；当前仅记录调用。'],
    ['on_pull_request_review', ['pull_request_review', 'pull_request_review.*'], 'PR 评审和行内评论入口；当前仅记录调用。'],
    ['on_pull_request_merged', ['pull_request.merged'], 'PR 合并后的分析入口；当前仅记录调用。'],
  ];
  for (const [method, routes, description] of analyze) bus.subscribe({ id: `analyze.${method}`, business: '内容分析', description, routes, mode: 'noop', handler: () => ({ hook: 'analyze', method, status: 'noop' }) });
  const boards: [string, string[], string[]?][] = [
    ['on_issue', ['issue', 'issue.*']], ['on_issue_comment', ['issue_comment', 'issue_comment.*']],
    ['on_pull_request', ['pull_request', 'pull_request.*', 'pull_request_review', 'pull_request_review.*'], ['pull_request.merged']],
    ['on_pull_request_merged', ['pull_request.merged']], ['on_push', ['push', 'push.*']],
    ['on_quality', QUALITY_KINDS.flatMap(kind => [kind, `${kind}.*`])],
  ];
  for (const [method, routes, exclude] of boards) bus.subscribe({ id: `board.${method}`, business: '看板更新', description: board.mode === 'active' ? '按源仓排队更新对应静态看板。' : '未启用静态发布，当前仅记录调用。',
    routes, exclude, mode: board.mode, providers: board.mode === 'active' ? ['github'] : [], repositories: board.repositories, handler: event => board.handle(method, event) });
}
export class Router {
  readonly bus = new EventBus();
  constructor(readonly board: Board = new NoopBoard()) { registerBuiltin(this.bus, board); }
  async dispatch(input: BotEvent): Promise<Outcome> {
    const event = input.kind === 'pull_request' && input.merged ? { ...input, action: 'merged' } : input;
    if (['ping', 'installation'].includes(event.kind)) return { ...outcome(routeOf(event), event.kind === 'ping' ? 'pong' : 'installation change recorded; no business listeners'), handled: true };
    const result = await this.bus.dispatch(event);
    if (!result.handled) result.note = 'no matching listener, recorded only';
    return result;
  }
}
