import { GitHubApp } from '../core/github-app.js';
import type { CallerInventory } from '../core/installations.js';
import { permissionCatalog } from '../core/permissions.js';
import { jsonResponse } from '../core/http.js';
import { workerConfig, type WorkerEnv } from './env.js';

/** No durable state, timers or ingestion mutex: the admin asks GitHub for a fresh directory. */
export async function readInstallations(env: WorkerEnv): Promise<CallerInventory> {
  const cfg = workerConfig(env);
  if (!cfg.github_app_id || !cfg.github_app_private_key) throw new Error('GitHub App credentials unavailable');
  const app = new GitHubApp(cfg.github_app_id, cfg.github_app_private_key);
  const installations = [];
  for (const installation of await app.installations()) installations.push(await app.repositories(installation));
  const tracked = new Set(cfg.repos.map(repo => repo.toLowerCase()));
  const eligible = installations.filter(row => !row.suspended).flatMap(row => row.repositories).filter(repo => tracked.has(repo.toLowerCase()));
  return { installations, eligible_repositories: [...new Set(eligible.map(repo => repo.toLowerCase()))].sort(), tracked_repositories: cfg.repos };
}
export async function installationResponse(env: WorkerEnv): Promise<Response> {
  try { return jsonResponse({ ok: true, ...await readInstallations(env), permission_catalog: permissionCatalog() }); }
  catch { return jsonResponse({ ok: false, error: 'GitHub 安装列表读取失败，请稍后手动刷新。' }, 503); }
}
