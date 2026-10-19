import { base64, fromBase64 } from './signature.js';
import { object, utf8, type Doc } from './types.js';
import { intersectPermissions, type AppInstallation, type InstallationInventory } from './installations.js';
import type { PermissionSet } from './permissions.js';

export class GitHubAppAuthError extends Error { constructor(readonly status?: number) { super('GitHub App authentication failed'); } }
export class InstallationPermissionError extends Error { constructor() { super('the installation has not approved any selected permission besides metadata'); } }
export interface InstallationGrant { token: string; expires_at: string; }
/** Collection tokens by default: the source is read-only; the dashboard target may write contents. */
export function collectionPermissions(write: boolean): Doc {
  return write ? { metadata: 'read', contents: 'write' }
    : { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' };
}
/** A certificate caller's permissions until the admin page chooses others: issues and pull requests, no contents. */
export const CALLER_PERMISSIONS: Readonly<Doc> = Object.freeze({ metadata: 'read', issues: 'write', pull_requests: 'write' });
const base64url = (bytes: Uint8Array): string => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function der(tag: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const length: number[] = []; let remaining = bytes.length;
  do { length.unshift(remaining & 255); remaining >>>= 8; } while (remaining);
  const prefix = bytes.length < 128 ? [tag, bytes.length] : [tag, 128 | length.length, ...length];
  return Uint8Array.from([...prefix, ...bytes]);
}
export async function loadPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replaceAll('\\n', '\n').trim();
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)\s+-----END \1-----$/.exec(normalized);
  if (!match) throw new TypeError('invalid RSA private key');
  let bytes = fromBase64(match[2].replace(/\s/g, ''));
  // GitHub downloads PKCS#1 keys. Web Crypto accepts PKCS#8; wrap the RSA DER
  // with its algorithm identifier without parsing or logging private components.
  if (match[1] === 'RSA PRIVATE KEY') bytes = der(0x30, Uint8Array.from([2, 1, 0, 0x30, 13, 6, 9, 0x2a, 0x86, 0x48, 0x86, 0xf7, 13, 1, 1, 1, 5, 0, ...der(4, bytes)]));
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
export class GitHubApp {
  private readonly key: Promise<CryptoKey>;
  // Workers' global fetch rejects a foreign receiver. An arrow also keeps the
  // injectable client from accidentally invoking it with this GitHubApp instance.
  constructor(readonly appId: string, privateKey: string, private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly clock = () => Date.now()) { this.key = loadPrivateKey(privateKey); }
  async jwt(): Promise<string> {
    const now = Math.floor(this.clock() / 1000);
    const header = base64url(utf8.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = base64url(utf8.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId })));
    const message = `${header}.${payload}`;
    return message + '.' + base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.key, utf8.encode(message))));
  }
  private async read(method: string, path: string, body?: Doc, token?: string): Promise<unknown> {
    try {
      const response = await this.fetcher('https://api.github.com' + path, { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + (token || await this.jwt()), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new GitHubAppAuthError(response.status); }
      return await response.json();
    } catch (error) { throw error instanceof GitHubAppAuthError ? error : new GitHubAppAuthError(); }
  }
  private async request(method: string, path: string, body?: Doc): Promise<Doc> { return object(await this.read(method, path, body)); }

  /** The App's directory is read only on demand by management, never during ingestion. */
  async installations(): Promise<AppInstallation[]> {
    const installations: AppInstallation[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.read('GET', `/app/installations?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new GitHubAppAuthError();
      for (const raw of rows) {
        const row = object(raw), account = object(row.account);
        if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || typeof account.login !== 'string'
          || !['all', 'selected'].includes(String(row.repository_selection))) throw new GitHubAppAuthError();
        const permissions = Object.fromEntries(Object.entries(object(row.permissions)).filter(([key, level]) => /^[a-z][a-z0-9_]*$/.test(key) && typeof level === 'string')) as Record<string, string>;
        installations.push({ id: Number(row.id), account: account.login, target_type: String(row.target_type || account.type || ''),
          repository_selection: String(row.repository_selection), suspended: !!row.suspended_at, permissions });
      }
      if (rows.length < 100) return installations;
    }
  }
  async repositories(installation: AppInstallation): Promise<InstallationInventory> {
    if (installation.suspended) return { ...installation, repositories: [], total_repositories: null, truncated: false };
    const grant = await this.createGrant(installation.id, { metadata: 'read' });
    const repositories: string[] = [];
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const result = object(await this.read('GET', `/installation/repositories?per_page=100&page=${page}`, undefined, grant.token));
      if (!Array.isArray(result.repositories) || !Number.isSafeInteger(result.total_count) || Number(result.total_count) < 0) throw new GitHubAppAuthError();
      total = Number(result.total_count);
      for (const raw of result.repositories) {
        const name = object(raw).full_name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new GitHubAppAuthError();
        if (repositories.length < 1000) repositories.push(name);
      }
      if (result.repositories.length < 100 || repositories.length >= total) break;
    }
    return { ...installation, repositories, total_repositories: total, truncated: total > repositories.length };
  }
  async tokenFor(repository: string, write = false): Promise<string> {
    return (await this.grantForCollection(repository, write)).token;
  }
  async grantForCollection(repository: string, write = false): Promise<InstallationGrant> {
    return this.installationToken(repository, collectionPermissions(write));
  }
  /** A token with exactly the permissions configured on the admin page, for one repository. */
  async grantWith(repository: string, permissions: Doc): Promise<InstallationGrant> {
    return this.installationToken(repository, { ...permissions });
  }
  async tokenForWorkflow(repository: string): Promise<string> {
    return (await this.installationToken(repository, { metadata: 'read', actions: 'write' })).token;
  }
  /** GitCode sync: read the pull request's objects and write its gate check, nothing else. */
  async tokenForSync(repository: string): Promise<string> {
    return (await this.installationToken(repository, { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'write' })).token;
  }
  /** Handed to a certificate caller, which then calls api.github.com itself, with that client's permissions. */
  async grantForCaller(repository: string, permissions: Doc = CALLER_PERMISSIONS, scope = [repository]): Promise<InstallationGrant & { permissions: PermissionSet }> {
    const installations = new Map<string, Doc>();
    for (const repo of new Set([...scope, repository].map(name => name.toLowerCase()))) {
      try {
        const installation = await this.repositoryInstallation(repo);
        if (!installation.suspended_at) installations.set(repo, installation);
      } catch (error) {
        if (!(error instanceof GitHubAppAuthError) || error.status !== 404) throw error;
      }
    }
    const target = installations.get(repository.toLowerCase());
    if (!target) throw new GitHubAppAuthError();
    const actual = intersectPermissions(permissions, ...[...installations.values()].map(installation => object(installation.permissions)));
    if (Object.keys(actual).length < 2) throw new InstallationPermissionError();
    return { ...await this.createGrant(Number(target.id), actual, repository), permissions: actual };
  }
  private async repositoryInstallation(repository: string): Promise<Doc> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new TypeError('invalid repository');
    const installation = await this.request('GET', `/repos/${repository}/installation`);
    if (!Number.isSafeInteger(installation.id) || Number(installation.id) <= 0) throw new GitHubAppAuthError();
    return installation;
  }
  private async installationToken(repository: string, permissions: Doc): Promise<InstallationGrant> {
    const installation = await this.repositoryInstallation(repository);
    if (installation.suspended_at) throw new GitHubAppAuthError();
    return this.createGrant(Number(installation.id), permissions, repository);
  }
  private async createGrant(id: number, permissions: Doc, repository?: string): Promise<InstallationGrant> {
    const result = await this.request('POST', `/app/installations/${id}/access_tokens`, { ...(repository ? { repositories: [repository.split('/')[1]] } : {}), permissions });
    if (typeof result.token !== 'string' || !result.token || typeof result.expires_at !== 'string' || !(Date.parse(result.expires_at) > this.clock() + 660000)) throw new GitHubAppAuthError();
    return { token: result.token, expires_at: result.expires_at };
  }
}

/** `via`: read through the App's installation there, or only through the public API. */
export interface RepositoryIdentity { full_name: string; id: string; owner_id: string; via: 'app' | 'public' }
/**
 * A repository's immutable IDs, read through the App when it is installed there (private
 * repositories too) and otherwise from GitHub's public API. Null when neither can read it.
 */
export async function repositoryIdentity(repository: string, app: GitHubApp | null, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<RepositoryIdentity | null> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  const read = async (via: 'app' | 'public', authorization?: string): Promise<RepositoryIdentity | null> => {
    const response = await fetcher('https://api.github.com/repos/' + repository, { redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot', ...(authorization ? { Authorization: authorization } : {}) } });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const doc = object(await response.json()), owner = object(doc.owner);
    return Number.isSafeInteger(doc.id) && Number.isSafeInteger(owner.id) && typeof doc.full_name === 'string'
      ? { full_name: doc.full_name, id: String(doc.id), owner_id: String(owner.id), via } : null;
  };
  if (app) {
    try { const found = await read('app', 'Bearer ' + (await app.grantWith(repository, { metadata: 'read' })).token); if (found) return found; }
    catch { /* the App is not installed there: try the public API */ }
  }
  try { return await read('public'); } catch { return null; }
}
