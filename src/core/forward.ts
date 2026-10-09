import { sign } from './signature.js';
import { array, object, string, type Doc } from './types.js';

/**
 * Webhook forwarding: subscriptions copy verified, archived deliveries to HTTPS endpoints.
 * Targets are checked by literal address only; the Worker cannot resolve names itself.
 */
export const FORWARD_LIMIT = 20;
export const FORWARD_TIMEOUT_MS = 5000;
export const FORWARD_PROVIDERS = ['github', 'gitcode'] as const;
export const FORWARD_TYPES = ['issue', 'issue_comment', 'pull_request', 'pull_request_review', 'push', 'ping', 'other'] as const;
const NAMED = new Set<string>(FORWARD_TYPES.filter(type => type !== 'other'));

export interface ForwardResult { at: string; delivery_id: string; status: number | null; error: string | null }
export interface ForwardSubscription {
  id: string; name: string; url: string; providers: string[]; types: string[]; secret: string;
  created: string; updated: string; last: ForwardResult | null;
}

// Cloud metadata services answer on these names besides 169.254.169.254.
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal', 'metadata.azure.com']);

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.map(Number);
}
function blockedIPv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
/** Expands an IPv6 literal (as normalized by URL) to eight 16-bit groups. */
function ipv6(host: string): number[] | null {
  if (!host.startsWith('[') || !host.endsWith(']')) return null;
  let body = host.slice(1, -1).toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (tail) {
    const v4 = ipv4(tail[1]); if (!v4) return null;
    body = body.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [head, rest] = body.split('::');
  const left = head ? head.split(':') : [], right = rest ? rest.split(':') : [];
  const groups = body.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}
function blockedIPv6(g: number[]): boolean {
  if (g.slice(0, 7).every(v => v === 0) && g[7] <= 1) return true;                       // :: and ::1
  if (g.slice(0, 5).every(v => v === 0) && (g[5] === 0xffff || g[5] === 0)) {            // IPv4-mapped / compatible
    return blockedIPv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return blockedIPv4([g[6] >> 8, g[6] & 255]);      // NAT64
  // Unique-local, link-local, site-local, multicast and documentation ranges.
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00 || g[0] === 0x2001 && g[1] === 0xdb8;
}
/** Why a target URL may not be used, or null when it may. */
export function targetProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'not a valid URL'; }
  if (url.protocol !== 'https:') return 'only https targets are allowed';
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  if (value.length > 2048) return 'URL is too long';
  // URL parsing already turns 0x7f.1, 2130706433 and similar spellings into dotted quads.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || METADATA_HOSTS.has(host)) return 'local or metadata host';
  const v4 = ipv4(host);
  if (v4) return blockedIPv4(v4) ? 'loopback, private, link-local or reserved address' : null;
  const v6 = ipv6(host);
  if (host.startsWith('[')) return !v6 || blockedIPv6(v6) ? 'loopback, private, link-local or reserved address' : null;
  return null;
}
const pick = (values: unknown, allowed: readonly string[]): string[] | null => {
  const list = array(values);
  if (!list.length || list.some(v => typeof v !== 'string' || !allowed.includes(v))) return null;
  return [...new Set(list as string[])].sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b));
};
/** Validates an admin request body; returns the fields or the reason it was refused. */
export function parseSubscription(input: unknown): { ok: true; value: Pick<ForwardSubscription, 'name' | 'url' | 'providers' | 'types' | 'secret'> } | { ok: false; error: string } {
  const doc = object(input), name = string(doc.name).trim(), url = string(doc.url).trim(), secret = string(doc.secret);
  if (!name || name.length > 80) return { ok: false, error: 'name must be 1-80 characters' };
  const problem = targetProblem(url);
  if (problem) return { ok: false, error: `target URL rejected: ${problem}` };
  const providers = pick(doc.providers, FORWARD_PROVIDERS), types = pick(doc.types, FORWARD_TYPES);
  if (!providers) return { ok: false, error: 'providers must be a non-empty subset of github, gitcode' };
  if (!types) return { ok: false, error: `types must be a non-empty subset of ${FORWARD_TYPES.join(', ')}` };
  if (doc.secret !== undefined && typeof doc.secret !== 'string' || secret.length > 256) return { ok: false, error: 'secret must be a string of at most 256 characters' };
  return { ok: true, value: { name, url, providers, types, secret } };
}
/** The subscription type an archived delivery falls under. */
export const forwardType = (kind: string): string => NAMED.has(kind) ? kind : 'other';
/** Verified and archived: accepted or out-of-scope deliveries, never rejected ones or redeliveries. */
export const forwardable = (record: Doc): boolean => (record.status === 'accepted' || record.status === 'ignored') && !record.duplicate;
export const matches = (sub: ForwardSubscription, record: Doc): boolean =>
  sub.providers.includes(string(record.provider)) && sub.types.includes(forwardType(string(record.kind)));

/** One delivery to one target: the original body, five seconds, no redirects. Never throws. */
export async function deliver(sub: ForwardSubscription, record: Doc, body: Uint8Array, contentType: string,
  fetcher: typeof fetch = (...args) => fetch(...args), now = () => new Date()): Promise<ForwardResult> {
  const delivery = string(record.delivery_id) || string(record.record_id);
  const result = (status: number | null, error: string | null): ForwardResult => ({ at: now().toISOString(), delivery_id: delivery, status, error });
  const problem = targetProblem(sub.url);
  if (problem) return result(null, `target rejected: ${problem}`);
  const headers: Record<string, string> = { 'Content-Type': contentType || 'application/json', 'User-Agent': 'sciencediscovery-bot-forward',
    'X-Sdbot-Provider': string(record.provider), 'X-Sdbot-Event': string(record.kind), 'X-Sdbot-Delivery': delivery };
  if (sub.secret) headers['X-Hub-Signature-256'] = await sign(body, sub.secret);
  try {
    const response = await fetcher(sub.url, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return result(response.status, null);
    return result(response.status, response.status >= 300 && response.status < 400 ? `redirect not followed (HTTP ${response.status})` : `HTTP ${response.status}`);
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return result(null, name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${FORWARD_TIMEOUT_MS / 1000} s` : 'network error');
  }
}
/** What the admin page shows; the secret is readable there and nowhere else. */
export const publicSubscription = (sub: ForwardSubscription): Doc => ({ ...sub, has_secret: !!sub.secret });
