import type { Config } from './config.js';
import { GitCodeApi, GitCodeApiError } from './gitcode-api.js';
import { GitHubApp } from './github-app.js';
import { CertificateError, parseCertificate, type CertificateInfo } from './x509.js';
import { array, object, string, type Doc } from './types.js';

/**
 * Certificate callers: external services that hold their own private key and call
 * /caller/v1 with a short-lived JWT. Only the public certificate is stored here.
 */
export const CALLER_AUDIENCE = 'sdbot:caller';
export const CALLER_OPERATIONS = ['comment', 'labels', 'state'] as const;
export type CallerOperation = typeof CALLER_OPERATIONS[number];
export const CALLER_PATHS: Record<string, CallerOperation> = { '/caller/v1/comments': 'comment', '/caller/v1/labels': 'labels', '/caller/v1/state': 'state' };
export const CALLER_LIMIT = 20;
export const CALLER_RATE_PER_MINUTE = 60;
/** Longest accepted token lifetime (exp - iat); also bounds how long a jti is remembered. */
export const CALLER_MAX_TOKEN_SECONDS = 600;
export const CALLER_CLOCK_TOLERANCE = 5;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CallerClient extends Omit<CertificateInfo, 'pem'> {
  id: string; name: string; certificate: string; operations: CallerOperation[]; repos: string[]; created: string; updated: string;
}
export interface CallerAudit { at: string; client: string; operation: string; provider: string; repo: string; number: number | null; upstream_status: number | null; result: string }
export type Refusal = { status: 401 | 403 | 422 | 429 | 502 | 503; error: string };

/** Admin input for a client; the certificate must be public-only and currently parseable. */
export async function parseClient(input: unknown): Promise<{ ok: true; value: Omit<CallerClient, 'id' | 'created' | 'updated'> } | { ok: false; error: string }> {
  const doc = object(input), name = string(doc.name).trim();
  if (!name || name.length > 80) return { ok: false, error: 'name must be 1-80 characters' };
  let cert: CertificateInfo;
  try { cert = await parseCertificate(string(doc.certificate)); }
  catch (error) { return { ok: false, error: error instanceof CertificateError ? error.message : 'could not read the certificate' }; }
  const operations = array(doc.operations);
  if (!operations.length || operations.some(op => !(CALLER_OPERATIONS as readonly unknown[]).includes(op))) return { ok: false, error: 'operations must be a non-empty subset of comment, labels, state' };
  const repos = array(doc.repos).map(r => typeof r === 'string' ? r.trim() : '').filter(Boolean);
  if (repos.length > 50 || repos.some(r => !REPO.test(r))) return { ok: false, error: 'repositories must be owner/name, at most 50' };
  const { pem, ...info } = cert;
  return { ok: true, value: { name, certificate: pem, ...info, operations: [...new Set(operations as CallerOperation[])], repos: [...new Set(repos.map(r => r.toLowerCase()))] } };
}

export interface CallerRequest { provider: 'github' | 'gitcode'; repo: string; number: number; body?: string; add?: string[]; remove?: string[]; state?: 'open' | 'closed' }
const labels = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  const list = array(value);
  if (!Array.isArray(value) || list.length > 50 || list.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) return null;
  return [...new Set((list as string[]).map(v => v.trim()))];
};
/** Validates the JSON body for one operation (422 on failure). */
export function parseCall(operation: CallerOperation, input: unknown): CallerRequest | Refusal {
  const doc = object(input), provider = doc.provider, repo = string(doc.repo).trim(), n = doc.number;
  if (provider !== 'github' && provider !== 'gitcode') return { status: 422, error: 'provider must be github or gitcode' };
  if (!REPO.test(repo)) return { status: 422, error: 'repo must be owner/name' };
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return { status: 422, error: 'number must be a positive integer' };
  const call: CallerRequest = { provider, repo, number: n };
  if (operation === 'comment') {
    if (typeof doc.body !== 'string' || !doc.body.trim() || doc.body.length > 65536) return { status: 422, error: 'body must be a non-empty string of at most 65536 characters' };
    call.body = doc.body;
  } else if (operation === 'labels') {
    const add = labels(doc.add), remove = labels(doc.remove);
    if (!add || !remove) return { status: 422, error: 'add and remove must be arrays of label names (1-100 characters, at most 50)' };
    if (!add.length && !remove.length) return { status: 422, error: 'add or remove at least one label' };
    Object.assign(call, { add, remove });
  } else {
    if (doc.state !== 'open' && doc.state !== 'closed') return { status: 422, error: 'state must be open or closed' };
    call.state = doc.state;
  }
  return call;
}

/** Repositories the bot may write on a platform: SDBOT_REPOS on GitHub, the active sync target on GitCode. */
export function configuredRepos(cfg: Config, provider: string): string[] | Refusal {
  if (provider === 'github') return cfg.repos.map(r => r.toLowerCase());
  const sync = cfg.gitcode_sync;
  if (!sync?.enabled) return { status: 403, error: `GitCode writes need active GitCode sync with a token (disabled: ${(sync?.disabled_reasons || ['no_token']).join(',')})` };
  return [sync.target.toLowerCase()];
}
/** 403 when the operation or repository is outside what the client and the bot allow. */
export function authorize(client: CallerClient, operation: CallerOperation, call: CallerRequest, cfg: Config): Refusal | null {
  if (!client.operations.includes(operation)) return { status: 403, error: `operation ${operation} is not allowed for this client` };
  const allowed = configuredRepos(cfg, call.provider);
  if (!Array.isArray(allowed)) return allowed;
  const repo = call.repo.toLowerCase();
  if (!allowed.includes(repo)) return { status: 403, error: `repository ${call.repo} is not configured for ${call.provider}` };
  if (client.repos.length && !client.repos.includes(repo)) return { status: 403, error: `repository ${call.repo} is not allowed for this client` };
  return null;
}

export interface Performed { ok: boolean; upstream_status: number | null; error?: string }
/** GitHub through a one-off installation token with issues and pull_requests write only. */
async function github(cfg: Config, operation: CallerOperation, call: CallerRequest, fetcher: typeof fetch): Promise<Performed> {
  if (!cfg.github_app_id || !cfg.github_app_private_key) return { ok: false, upstream_status: null, error: 'GitHub App credentials are not configured' };
  let token: string;
  try { token = await new GitHubApp(cfg.github_app_id, cfg.github_app_private_key, fetcher).tokenForCaller(call.repo); }
  catch { return { ok: false, upstream_status: null, error: 'GitHub App could not get an installation token for this repository' }; }
  const send = async (method: string, path: string, body?: unknown): Promise<number> => {
    const response = await fetcher(`https://api.github.com/repos/${call.repo}/issues/${call.number}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  };
  try {
    let status: number;
    if (operation === 'comment') status = await send('POST', '/comments', { body: call.body });
    else if (operation === 'state') status = await send('PATCH', '', { state: call.state });
    else {
      status = 200;
      if (call.add!.length) status = await send('POST', '/labels', { labels: call.add });
      for (const name of call.remove!) {
        if (status >= 300) break;
        // Removing a label the item does not carry is already the requested state.
        const removed = await send('DELETE', `/labels/${encodeURIComponent(name)}`);
        status = removed === 404 ? status : removed;
      }
    }
    return status >= 200 && status < 300 ? { ok: true, upstream_status: status } : { ok: false, upstream_status: status, error: `GitHub returned HTTP ${status}` };
  } catch { return { ok: false, upstream_status: null, error: 'GitHub request failed before a response' }; }
}
/** GitCode merge requests of the sync target, with the sync token. */
async function gitcode(cfg: Config, operation: CallerOperation, call: CallerRequest, fetcher: typeof fetch): Promise<Performed> {
  const sync = cfg.gitcode_sync, api = new GitCodeApi({ api_url: sync.api_url, web_url: sync.web_url, token: sync.token, auth_mode: sync.auth_mode }, fetcher);
  try {
    if (operation === 'comment') await api.addComment(call.repo, call.number, call.body!);
    else if (operation === 'state') await api.updatePull(call.repo, call.number, { state: call.state });
    else {
      if (call.add!.length) await api.addLabels(call.repo, call.number, call.add!);
      for (const name of call.remove!) {
        try { await api.removeLabel(call.repo, call.number, name); }
        catch (error) { if (!(error instanceof GitCodeApiError && error.status === 404)) throw error; }
      }
    }
    return { ok: true, upstream_status: api.lastStatus };
  } catch (error) {
    return error instanceof GitCodeApiError ? { ok: false, upstream_status: error.status, error: error.message } : { ok: false, upstream_status: null, error: 'GitCode request failed' };
  }
}
export function perform(cfg: Config, operation: CallerOperation, call: CallerRequest, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<Performed> {
  return call.provider === 'github' ? github(cfg, operation, call, fetcher) : gitcode(cfg, operation, call, fetcher);
}
/** What the admin page lists for a client. */
export const publicClient = (client: CallerClient): Doc => ({ ...client });
