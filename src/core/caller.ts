import type { Config } from './config.js';
import { CertificateError, parseCertificate, type CertificateInfo } from './x509.js';
import { array, object, string, type Doc } from './types.js';

/**
 * Certificate callers: external services that hold their own private key, prove themselves with a
 * short-lived JWT and exchange it for a GitHub installation token they then use directly.
 * Only the public certificate is stored here.
 */
export const CALLER_AUDIENCE = 'sdbot:caller';
export const CALLER_TOKEN_PATH = '/caller/v1/token';
export const CALLER_LIMIT = 20;
export const CALLER_RATE_PER_MINUTE = 60;
/** Longest accepted token lifetime (exp - iat); also bounds how long a jti is remembered. */
export const CALLER_MAX_TOKEN_SECONDS = 600;
export const CALLER_CLOCK_TOLERANCE = 5;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CallerClient extends Omit<CertificateInfo, 'pem'> {
  id: string; name: string; certificate: string; repos: string[]; created: string; updated: string;
}
export type Refusal = { status: 401 | 403 | 422 | 429 | 503; error: string };

/** Admin input for a client; the certificate must be public-only and currently parseable. */
export async function parseClient(input: unknown): Promise<{ ok: true; value: Omit<CallerClient, 'id' | 'created' | 'updated'> } | { ok: false; error: string }> {
  const doc = object(input), name = string(doc.name).trim();
  if (!name || name.length > 80) return { ok: false, error: 'name must be 1-80 characters' };
  let cert: CertificateInfo;
  try { cert = await parseCertificate(string(doc.certificate)); }
  catch (error) { return { ok: false, error: error instanceof CertificateError ? error.message : 'could not read the certificate' }; }
  const repos = array(doc.repos).map(r => typeof r === 'string' ? r.trim() : '').filter(Boolean);
  if (repos.length > 50 || repos.some(r => !REPO.test(r))) return { ok: false, error: 'repositories must be owner/name, at most 50' };
  const { pem, ...info } = cert;
  return { ok: true, value: { name, certificate: pem, ...info, repos: [...new Set(repos.map(r => r.toLowerCase()))] } };
}

/** The exchange body is exactly { "repo": "owner/name" } (422 otherwise). */
export function parseTokenRequest(input: unknown): { repo: string } | Refusal {
  const doc = object(input);
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(doc).join() !== 'repo') return { status: 422, error: 'body must be exactly {"repo": "owner/name"}' };
  const repo = string(doc.repo).trim();
  if (!REPO.test(repo)) return { status: 422, error: 'repo must be owner/name' };
  return { repo };
}
/** 403 unless the repository is in SDBOT_REPOS and, when the client has a list, in that list too. */
export function authorizeRepo(client: CallerClient, repo: string, cfg: Config): Refusal | null {
  const wanted = repo.toLowerCase();
  if (!cfg.repos.some(r => r.toLowerCase() === wanted)) return { status: 403, error: `repository ${repo} is not in SDBOT_REPOS` };
  if (client.repos.length && !client.repos.includes(wanted)) return { status: 403, error: `repository ${repo} is not allowed for this client` };
  return null;
}
export const publicClient = (client: CallerClient): Doc => ({ ...client });
