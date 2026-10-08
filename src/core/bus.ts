import { category, object, outcome, routeOf, type Board, type BotEvent, type Doc, type Outcome, type PullRequestSync, type SyncDisabledReason } from './types.js';
import { disabledSync } from './config.js';

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
  /** reason is set when targets exist but publishing credentials are missing. */
  constructor(readonly reason: '' | 'no_github_app' = '') {}
  async handle(method: string, _event: BotEvent): Promise<Doc> { return { hook: 'board', method, status: 'noop' }; }
  status(): Doc { return this.reason ? { enabled: false, reason: this.reason } : { enabled: false }; }
}
export class NoopSync implements PullRequestSync {
  readonly mode = 'noop' as const; readonly source = ''; readonly target = '';
  readonly disabledReasons: readonly SyncDisabledReason[];
  constructor(reasons: readonly SyncDisabledReason[] = ['no_token']) { this.disabledReasons = reasons.length ? [...reasons] : ['no_token']; }
  async handle(_event: BotEvent): Promise<Doc> { return { hook: 'gitcode_sync', method: 'on_pull_request', status: 'noop' }; }
  async wake(_event: BotEvent): Promise<Doc> { return { hook: 'gitcode_sync', method: 'on_codecheck_event', status: 'noop' }; }
  status(): Doc { return disabledSync(this.disabledReasons); }
  async snapshot(): Promise<Doc> { return { ok: true, ...disabledSync(this.disabledReasons), records: [], pulls: [] }; }
}
export const SYNC_DISABLED: Record<SyncDisabledReason, string> = {
  off: 'SDBOT_GITCODE_SYNC_TARGET=off',
  no_token: '未设置 GITCODE_TOKEN',
  no_github_app: '缺少 GitHub App 凭据（SDBOT_GITHUB_APP_ID 与 SDBOT_GITHUB_APP_PRIVATE_KEY）',
  no_webhook_secret: '缺少 GitHub Webhook secret（SDBOT_GITHUB_WEBHOOK_SECRET）',
};
/** Listener text naming every missing item, e.g. both credentials at once. */
export const syncDisabledText = (reasons: readonly SyncDisabledReason[]): string =>
  `${(reasons.length ? reasons : ['no_token' as const]).map(r => SYNC_DISABLED[r]).join('；')}，GitCode 同步已停用。`;
export const SYNC_ROUTES = ['opened', 'synchronize', 'reopened', 'closed', 'merged'].map(a => `pull_request.${a}`);
/** GitCode merge request comments (new or edited both arrive as created) and merge request updates such as label changes. */
export const CODECHECK_ROUTES = ['issue_comment.created', 'pull_request.edited'];
export function registerBuiltin(bus: EventBus, board: Board, sync: PullRequestSync = new NoopSync()): void {
  const analyze: [string, string[], string][] = [
    ['on_issue', ['issue.opened', 'issue.edited', 'issue.reopened'], 'Issue 新建、编辑和重新打开的分析入口；当前仅记录调用。'],
    ['on_issue_comment', ['issue_comment', 'issue_comment.*'], 'Issue / PR 评论分析入口；当前仅记录调用。'],
    ['on_pull_request', ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'].map(a => `pull_request.${a}`), 'PR 变更分析入口；当前仅记录调用。'],
    ['on_pull_request_review', ['pull_request_review', 'pull_request_review.*'], 'PR 评审和行内评论入口；当前仅记录调用。'],
    ['on_pull_request_merged', ['pull_request.merged'], 'PR 合并后的分析入口；当前仅记录调用。'],
  ];
  for (const [method, routes, description] of analyze) bus.subscribe({ id: `analyze.${method}`, business: '内容分析', description, routes, mode: 'noop', handler: () => ({ hook: 'analyze', method, status: 'noop' }) });
  // The dashboards show steady states. Refresh when work is created, closed or
  // reviewed and when a workflow run finishes; progress events (jobs, checks,
  // pushes, edits, comments) wait for the scheduled refresh.
  const boards: [string, string[], string[]?][] = [
    ['on_issue', ['issue.opened', 'issue.closed', 'issue.reopened']],
    ['on_pull_request', ['opened', 'closed', 'reopened', 'ready_for_review'].map(a => `pull_request.${a}`).concat('pull_request_review.submitted')],
    ['on_pull_request_merged', ['pull_request.merged']],
    ['on_run_completed', ['workflow_run.completed']],
    ['on_release', ['release.published']],
  ];
  for (const [method, routes, exclude] of boards) bus.subscribe({ id: `board.${method}`, business: '看板更新', description: board.mode === 'active' ? '按源仓排队更新对应静态看板。' : '未启用静态发布，当前仅记录调用。',
    routes, exclude, mode: board.mode, providers: board.mode === 'active' ? ['github'] : [], repositories: board.repositories, handler: event => board.handle(method, event) });
  // Without a token, with target `off`, or with missing GitHub credentials, the listener stays registered
  // but disabled, so PR routes and hooks are unchanged and the Worker keeps serving everything else.
  const active = sync.mode === 'active';
  bus.subscribe({ id: 'gitcode_sync.on_pull_request', business: 'GitCode 同步', routes: SYNC_ROUTES, mode: sync.mode, enabled: active,
    description: active ? '把 GitHub PR 的创建、更新、重新打开、关闭和合并排入持久队列，同步到 GitCode MR，并以 GitHub Check 等待 CodeCheck 结论。' : syncDisabledText(sync.disabledReasons),
    providers: active ? ['github'] : [], repositories: active ? [sync.source] : [], handler: event => sync.handle(event) });
  // The verdict is read when GitCode reports activity on the merge request, not on a timer; a deadline read remains.
  bus.subscribe({ id: 'gitcode_sync.on_codecheck_event', business: 'GitCode 同步', routes: CODECHECK_ROUTES, mode: sync.mode, enabled: active,
    description: active ? 'CI 账号在同步 MR 上发评论或 MR 标签变化时，立即读取一次该 MR 的 CodeCheck 结论并写 GitHub Check；不轮询。' : syncDisabledText(sync.disabledReasons),
    providers: active ? ['gitcode'] : [], repositories: active ? [sync.target] : [], handler: event => sync.wake(event) });
}
export class Router {
  readonly bus = new EventBus();
  constructor(readonly board: Board = new NoopBoard(), readonly sync: PullRequestSync = new NoopSync()) { registerBuiltin(this.bus, board, sync); }
  async dispatch(input: BotEvent): Promise<Outcome> {
    const event = input.kind === 'pull_request' && input.merged ? { ...input, action: 'merged' } : input;
    if (['ping', 'installation'].includes(event.kind)) return { ...outcome(routeOf(event), event.kind === 'ping' ? 'pong' : 'installation change recorded; no business listeners'), handled: true };
    const result = await this.bus.dispatch(event);
    if (!result.handled) result.note = 'no matching listener, recorded only';
    return result;
  }
}
