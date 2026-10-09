/** GitCode REST v5 client for merge requests. Merging is deliberately not implemented. */
import { scrub } from './redact.js';
import { array, object, string, type Doc } from './types.js';

type Fetcher = typeof fetch;
export class GitCodeApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null, readonly transient = false) { super(message); }
}
export interface GitCodePull { number: number; url: string; state: string; title: string; body: string; head_ref: string; head_sha: string; head_repo: string; base_ref: string; labels: string[] }
export interface GitCodeComment { id: string; body: string; author: string; created_at: number; url: string }
export interface GitCodeApiOptions { api_url: string; web_url: string; token: string; auth_mode: 'header' | 'query' }

/**
 * The merge request number (`!N`) from `number` or `iid`, as a JSON integer or an integer string such as "175".
 * GitCode's global `id` is a different identifier and is never used.
 */
export function mergeRequestNumber(value: unknown): number | null {
  const doc = object(value);
  for (const raw of [doc.number, doc.iid]) {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}
const missingNumber = (): GitCodeApiError => new GitCodeApiError('gitcode_error', 'GitCode returned a merge request without a number');
const messageOf = (value: unknown): string => {
  const doc = object(value);
  for (const key of ['error_message', 'message', 'error', 'msg']) if (typeof doc[key] === 'string') return doc[key] as string;
  return '';
};
export class GitCodeApi {
  /** HTTP status of the most recent successful request, for audit records. */
  lastStatus: number | null = null;
  constructor(readonly options: GitCodeApiOptions, private readonly fetcher: Fetcher = (...args) => fetch(...args)) {}
  private async request(label: string, method: string, path: string, query: Record<string, string | number> = {}, body?: Doc | unknown[]): Promise<unknown> {
    const url = new URL(this.options.api_url.replace(/\/+$/, '') + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'sciencediscovery-bot' };
    // Header authentication keeps the token out of URLs; query mode exists for gateways that require it.
    if (this.options.auth_mode === 'query') url.searchParams.set('access_token', this.options.token);
    else headers['PRIVATE-TOKEN'] = this.options.token;
    if (body) headers['Content-Type'] = 'application/json';
    let response: Response;
    try { response = await this.fetcher(url.toString(), { method, headers, redirect: 'manual', signal: AbortSignal.timeout(30000), ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new GitCodeApiError('gitcode_unreachable', `GitCode ${label} failed before a response`, null, true); }
    if (!response.ok) {
      let detail = '';
      try { detail = messageOf(JSON.parse((await response.text()).slice(0, 4096))); } catch { /* non-JSON error body is not shown */ }
      const status = response.status;
      const code = status === 401 || status === 403 ? 'permission_denied' : status === 404 ? 'not_found' : status === 409 || status === 422 ? 'rejected' : status === 429 ? 'rate_limited' : 'gitcode_error';
      // Error bodies can echo the request; redact before shortening.
      const shown = scrub(detail.replace(/\s+/g, ' '), [this.options.token], 160);
      throw new GitCodeApiError(code, `GitCode ${label} returned HTTP ${status}${shown ? ': ' + shown : ''}`, status, status === 429 || status >= 500);
    }
    this.lastStatus = response.status;
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new GitCodeApiError('gitcode_error', `GitCode ${label} returned invalid JSON`, response.status, true); }
  }
  private pull(repository: string, value: unknown): GitCodePull {
    const p = object(value), head = object(p.head), base = object(p.base), n = mergeRequestNumber(p);
    if (n === null) throw missingNumber();
    return { number: n, url: string(p.html_url) || `${this.options.web_url.replace(/\/+$/, '')}/${repository}/merge_requests/${n}`, state: string(p.state),
      title: string(p.title), body: string(p.body), head_ref: string(head.ref), head_sha: string(head.sha), head_repo: string(object(head.repo).full_name),
      base_ref: string(base.ref), labels: array(p.labels).map(l => typeof l === 'string' ? l : string(object(l).name)).filter(Boolean) };
  }
  async defaultBranch(repository: string): Promise<string> {
    return string(object(await this.request('repository lookup', 'GET', `/repos/${repository}`)).default_branch);
  }
  async branchExists(repository: string, branch: string): Promise<boolean> {
    try { await this.request('branch lookup', 'GET', `/repos/${repository}/branches/${encodeURIComponent(branch)}`); return true; }
    catch (error) { if (error instanceof GitCodeApiError && error.status === 404) return false; throw error; }
  }
  async branchCommits(repository: string, branch: string, limit = 100): Promise<string[]> {
    const list = array(await this.request('commit list', 'GET', `/repos/${repository}/commits`, { sha: branch, per_page: Math.min(limit, 100) }));
    return list.map(c => string(object(c).sha)).filter(sha => /^[0-9a-f]{40}$/.test(sha));
  }
  async findPull(repository: string, branch: string, headRepository: string): Promise<GitCodePull | null> {
    const found: GitCodePull[] = [];
    for (let page = 1; page <= 3; page++) {
      const list = array(await this.request('merge request list', 'GET', `/repos/${repository}/pulls`, { state: 'all', per_page: 100, page }));
      for (const item of list) {
        // One malformed entry must not hide the merge request next to it.
        if (mergeRequestNumber(item) === null) continue;
        const pull = this.pull(repository, item);
        if (pull.head_ref === branch && (!pull.head_repo || pull.head_repo.toLowerCase() === headRepository.toLowerCase())) found.push(pull);
      }
      if (list.length < 100) break;
    }
    return found.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.number - a.number)[0] || null;
  }
  async getPull(repository: string, n: number): Promise<GitCodePull> {
    return this.pull(repository, await this.request('merge request lookup', 'GET', `/repos/${repository}/pulls/${n}`));
  }
  async createPull(repository: string, fields: { title: string; head: string; base: string; body: string }): Promise<GitCodePull> {
    return this.pull(repository, await this.request('merge request creation', 'POST', `/repos/${repository}/pulls`, {}, fields));
  }
  async updatePull(repository: string, n: number, fields: { title?: string; body?: string; state?: 'open' | 'closed' }): Promise<GitCodePull> {
    const updated = await this.request('merge request update', 'PATCH', `/repos/${repository}/pulls/${n}`, {}, fields);
    if (mergeRequestNumber(updated) !== null) return this.pull(repository, updated);
    // The update was accepted but its response does not say which merge request it is; read !n back instead of failing the sync.
    try { return await this.getPull(repository, n); } catch { throw missingNumber(); }
  }
  async pullCommitCount(repository: string, n: number): Promise<number> {
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const list = array(await this.request('merge request commits', 'GET', `/repos/${repository}/pulls/${n}/commits`, { per_page: 100, page }));
      total += list.length;
      if (list.length < 100) break;
    }
    return total;
  }
  /** Certificate callers act on merge requests of the sync target only. */
  async addComment(repository: string, n: number, body: string): Promise<void> {
    await this.request('merge request comment', 'POST', `/repos/${repository}/pulls/${n}/comments`, {}, { body });
  }
  async addLabels(repository: string, n: number, labels: string[]): Promise<void> {
    await this.request('merge request labels', 'POST', `/repos/${repository}/pulls/${n}/labels`, {}, labels);
  }
  async removeLabel(repository: string, n: number, label: string): Promise<void> {
    await this.request('merge request label removal', 'DELETE', `/repos/${repository}/pulls/${n}/labels/${encodeURIComponent(label)}`);
  }
  async comments(repository: string, n: number): Promise<GitCodeComment[]> {
    const all: GitCodeComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const list = array(await this.request('merge request comments', 'GET', `/repos/${repository}/pulls/${n}/comments`, { per_page: 100, page }));
      for (const item of list) {
        const c = object(item), created = Date.parse(string(c.created_at));
        all.push({ id: String(c.id ?? ''), body: string(c.body), author: string(object(c.user).login) || string(object(c.user).username), created_at: Number.isFinite(created) ? created : 0, url: string(c.html_url) });
      }
      if (list.length < 100) break;
    }
    return all;
  }
}
