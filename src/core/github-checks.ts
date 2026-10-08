/** GitHub check runs written by the GitCode sync. Titles and summaries are English: they appear on GitHub. */
import { number, object } from './types.js';

type Fetcher = typeof fetch;
export class GitHubCheckError extends Error {
  constructor(readonly status: number | null) { super(status === null ? 'GitHub check update failed before a response' : `GitHub check update returned HTTP ${status}`); }
}
export type CheckConclusion = 'success' | 'failure' | 'timed_out' | 'cancelled' | 'neutral';
export interface CheckWrite {
  id: number | null; name: string; head_sha: string; external_id: string; details_url?: string | null;
  status: 'in_progress' | 'completed'; conclusion?: CheckConclusion; title: string; summary: string;
}
export async function upsertCheck(repository: string, token: string, check: CheckWrite, fetcher: Fetcher = (...args) => fetch(...args)): Promise<number> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(check.head_sha)) throw new TypeError('invalid check target');
  const body: Record<string, unknown> = { name: check.name, external_id: check.external_id, status: check.status,
    output: { title: check.title.slice(0, 250), summary: check.summary.slice(0, 60000) } };
  if (check.details_url && /^https?:\/\//.test(check.details_url)) body.details_url = check.details_url;
  if (check.status === 'completed') { body.conclusion = check.conclusion; body.completed_at = new Date().toISOString(); }
  if (check.id === null) body.head_sha = check.head_sha;
  const path = check.id === null ? `/repos/${repository}/check-runs` : `/repos/${repository}/check-runs/${check.id}`;
  let response: Response;
  try {
    response = await fetcher('https://api.github.com' + path, { method: check.id === null ? 'POST' : 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot' },
      body: JSON.stringify(body) });
  } catch { throw new GitHubCheckError(null); }
  if (!response.ok) { await response.body?.cancel(); throw new GitHubCheckError(response.status); }
  const id = number(object(await response.json().catch(() => ({}))).id);
  if (id === null) throw new GitHubCheckError(response.status);
  return id;
}
