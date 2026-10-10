/** Read-only GitHub lookups for mirroring a merge onto GitCode, made with the sync installation token. */
import { number, object, string, type Doc } from './types.js';

type Fetcher = typeof fetch;
export class GitHubRepoError extends Error {
  constructor(readonly code: string, message: string, readonly transient: boolean) { super(message); }
}
const SHA = /^[0-9a-f]{40}$/;

async function get(path: string, token: string, fetcher: Fetcher, label: string): Promise<Doc | null> {
  let response: Response;
  try {
    response = await fetcher('https://api.github.com' + path, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot' } });
  } catch { throw new GitHubRepoError('github_unreachable', `GitHub ${label} failed before a response`, true); }
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubRepoError(response.status === 401 || response.status === 403 ? 'github_permission_denied' : 'github_error', `GitHub ${label} returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500);
  }
  return object(await response.json().catch(() => ({})));
}

export async function githubDefaultBranch(repository: string, token: string, fetcher: Fetcher): Promise<string> {
  const branch = string(object(await get(`/repos/${repository}`, token, fetcher, 'repository lookup')).default_branch);
  if (!branch) throw new GitHubRepoError('github_error', 'GitHub did not report a default branch', false);
  return branch;
}
export async function githubBranchTip(repository: string, branch: string, token: string, fetcher: Fetcher): Promise<string> {
  const sha = string(object(object(await get(`/repos/${repository}/branches/${encodeURIComponent(branch)}`, token, fetcher, 'branch lookup')).commit).sha);
  if (!SHA.test(sha)) throw new GitHubRepoError('github_error', `GitHub did not report the tip of ${branch}`, false);
  return sha;
}
/** How `head` relates to `base` on GitHub; `unknown` when GitHub does not have `base` (e.g. a GitCode-only commit). */
export async function githubCompare(repository: string, base: string, head: string, token: string, fetcher: Fetcher): Promise<string> {
  if (!SHA.test(base) || !SHA.test(head)) return 'unknown';
  const doc = await get(`/repos/${repository}/compare/${base}...${head}`, token, fetcher, 'commit comparison');
  return doc ? string(doc.status) || 'unknown' : 'unknown';
}
/** How many commits `head` has that `base` lacks, per GitHub; null when GitHub does not have one of them. */
export async function githubAheadBy(repository: string, base: string, head: string, token: string, fetcher: Fetcher): Promise<number | null> {
  if (!SHA.test(base) || !SHA.test(head)) return null;
  const doc = await get(`/repos/${repository}/compare/${base}...${head}`, token, fetcher, 'commit comparison');
  return doc ? number(doc.ahead_by) : null;
}
