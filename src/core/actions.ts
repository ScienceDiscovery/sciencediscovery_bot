import { GitHubApp } from './github-app.js';

/** Dispatch only: acceptance by GitHub is not completion of collection or Pages. */
export async function dispatchCollection(app: GitHubApp, source: string, destination: string, generation: number, fetcher: typeof fetch = fetch): Promise<void> {
  if (![source, destination].every(r => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) || !Number.isSafeInteger(generation) || generation < 1) throw new TypeError('invalid collection request');
  const token = await app.tokenForWorkflow(destination);
  const response = await fetcher(`https://api.github.com/repos/${destination}/actions/workflows/collect.yml/dispatches`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot' },
    body: JSON.stringify({ ref: 'main', inputs: { source_repository: source, request_id: `refresh-${generation}` } }),
  });
  await response.body?.cancel();
  if (![200, 204].includes(response.status)) throw new Error('collection dispatch failed');
}
