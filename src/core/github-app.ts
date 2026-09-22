import { base64, fromBase64 } from './signature.js';
import { object, utf8, type Doc } from './types.js';

export class GitHubAppAuthError extends Error { constructor() { super('GitHub App authentication failed'); } }
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
  constructor(readonly appId: string, privateKey: string, private readonly fetcher: typeof fetch = fetch, private readonly clock = () => Date.now()) { this.key = loadPrivateKey(privateKey); }
  async jwt(): Promise<string> {
    const now = Math.floor(this.clock() / 1000);
    const header = base64url(utf8.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = base64url(utf8.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId })));
    const message = `${header}.${payload}`;
    return message + '.' + base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.key, utf8.encode(message))));
  }
  private async request(method: string, path: string, body?: Doc): Promise<Doc> {
    try {
      const response = await this.fetcher('https://api.github.com' + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + await this.jwt(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sciencediscovery-bot' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new GitHubAppAuthError(); }
      return object(await response.json());
    } catch { throw new GitHubAppAuthError(); }
  }
  async tokenFor(repository: string, write = false): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new TypeError('invalid repository');
    const installation = await this.request('GET', `/repos/${repository}/installation`);
    if (!Number.isSafeInteger(installation.id) || Number(installation.id) <= 0 || installation.suspended_at) throw new GitHubAppAuthError();
    const permissions: Doc = { metadata: 'read', contents: write ? 'write' : 'read' };
    if (!write) Object.assign(permissions, { issues: 'read', pull_requests: 'read', actions: 'read', checks: 'read', statuses: 'read' });
    const result = await this.request('POST', `/app/installations/${installation.id}/access_tokens`, { repositories: [repository.split('/')[1]], permissions });
    if (typeof result.token !== 'string' || !result.token || typeof result.expires_at !== 'string' || !(Date.parse(result.expires_at) > this.clock() + 660000)) throw new GitHubAppAuthError();
    return result.token;
  }
}
