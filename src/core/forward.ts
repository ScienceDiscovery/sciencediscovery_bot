import { scrub } from './redact.js';
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

export const FORWARD_REPO_LIMIT = 50;
export const FORWARD_HEADER_LIMIT = 10;
/** Results kept per subscription, newest first, including test sends. */
export const FORWARD_HISTORY = 20;

export interface ForwardResult {
  at: string; delivery_id: string; status: number | null; error: string | null;
  /** Older results lack these. */
  duration_ms?: number; event?: string; repo?: string; test?: boolean;
}
export interface ForwardHeader { name: string; value: string }
export interface ForwardSubscription {
  id: string; name: string; url: string; providers: string[]; types: string[]; secret: string;
  /** owner/name, lower case; empty forwards every repository. */
  repos: string[];
  /** Extra request headers such as Authorization; values are credentials and stay admin-only. */
  headers: ForwardHeader[];
  created: string; updated: string; last: ForwardResult | null;
  /** The latest results, newest first; `last` is the first of them. */
  recent?: ForwardResult[];
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
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// RFC 9110 token characters for a field name.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
// Headers the bot sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'host', 'connection', 'keep-alive', 'upgrade', 'te',
  'trailer', 'expect', 'cookie', 'user-agent', 'x-hub-signature-256']);
const reservedHeader = (name: string): boolean => RESERVED_HEADERS.has(name) || name.startsWith('x-sdbot-') || name.startsWith('proxy-') || name.startsWith('cf-') || name.startsWith('sec-');
function parseRepos(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'repos must be a list of owner/name';
  const repos = value.map(r => typeof r === 'string' ? r.trim() : '').filter(Boolean);
  if (repos.length !== value.length && value.some(r => typeof r !== 'string')) return 'repos must be a list of owner/name';
  if (repos.length > FORWARD_REPO_LIMIT || repos.some(r => !REPO.test(r))) return `repos must be owner/name, at most ${FORWARD_REPO_LIMIT}`;
  return [...new Set(repos.map(r => r.toLowerCase()))];
}
function parseHeaders(value: unknown): ForwardHeader[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'headers must be a list of {name, value}';
  const headers: ForwardHeader[] = [], seen = new Set<string>();
  for (const item of value) {
    const entry = object(item), name = string(entry.name).trim(), text = string(entry.value);
    if (!HEADER_NAME.test(name)) return `header name ${JSON.stringify(name.slice(0, 64))} is not a valid field name`;
    const lower = name.toLowerCase();
    if (reservedHeader(lower)) return `header ${name} is set by the bot or controls the connection and cannot be configured`;
    if (seen.has(lower)) return `header ${name} appears more than once`;
    // Line breaks or other control characters could smuggle extra headers.
    if (typeof entry.value !== 'string' || text.length > 1024 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(text)) return `header ${name} needs a value of at most 1024 characters without line breaks`;
    seen.add(lower);
    headers.push({ name, value: text.trim() });
  }
  if (headers.length > FORWARD_HEADER_LIMIT) return `at most ${FORWARD_HEADER_LIMIT} headers`;
  return headers;
}
const pick = (values: unknown, allowed: readonly string[]): string[] | null => {
  const list = array(values);
  if (!list.length || list.some(v => typeof v !== 'string' || !allowed.includes(v))) return null;
  return [...new Set(list as string[])].sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b));
};
/** Validates an admin request body; returns the fields or the reason it was refused. */
export function parseSubscription(input: unknown): { ok: true; value: Pick<ForwardSubscription, 'name' | 'url' | 'providers' | 'types' | 'secret' | 'repos' | 'headers'> } | { ok: false; error: string } {
  const doc = object(input), name = string(doc.name).trim(), url = string(doc.url).trim(), secret = string(doc.secret);
  if (!name || name.length > 80) return { ok: false, error: 'name must be 1-80 characters' };
  const problem = targetProblem(url);
  if (problem) return { ok: false, error: `target URL rejected: ${problem}` };
  const providers = pick(doc.providers, FORWARD_PROVIDERS), types = pick(doc.types, FORWARD_TYPES);
  if (!providers) return { ok: false, error: 'providers must be a non-empty subset of github, gitcode' };
  if (!types) return { ok: false, error: `types must be a non-empty subset of ${FORWARD_TYPES.join(', ')}` };
  if (doc.secret !== undefined && typeof doc.secret !== 'string' || secret.length > 256) return { ok: false, error: 'secret must be a string of at most 256 characters' };
  const repos = parseRepos(doc.repos), headers = parseHeaders(doc.headers);
  if (typeof repos === 'string') return { ok: false, error: repos };
  if (typeof headers === 'string') return { ok: false, error: headers };
  return { ok: true, value: { name, url, providers, types, secret, repos, headers } };
}
/** The subscription type an archived delivery falls under. */
export const forwardType = (kind: string): string => NAMED.has(kind) ? kind : 'other';
/** Verified and archived: accepted or out-of-scope deliveries, never rejected ones or redeliveries. */
export const forwardable = (record: Doc): boolean => (record.status === 'accepted' || record.status === 'ignored') && !record.duplicate;
/** Source, type and, when the subscription lists repositories, the delivery's repository (case-insensitive). */
export const matches = (sub: ForwardSubscription, record: Doc): boolean =>
  sub.providers.includes(string(record.provider)) && sub.types.includes(forwardType(string(record.kind)))
  && (!sub.repos?.length || sub.repos.includes(string(record.repo).toLowerCase()));

type Sent = { result: ForwardResult; excerpt: string | null };
/** The first `limit` bytes of a response body; the rest is cancelled, and a failed read keeps what arrived. */
async function bodyStart(response: Response, limit = 4096): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, limit - size);
      bytes.set(take, size);
      size += take.length;
    }
  } catch { /* timed out or reset: show what arrived */ }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(bytes.subarray(0, size));
}
/** Sends one request to a subscription's target: five seconds, no redirects. Never throws. */
async function send(sub: ForwardSubscription, record: Doc, body: Uint8Array, contentType: string, fetcher: typeof fetch, now: () => Date,
  extra: Record<string, string> = {}, readBody = false): Promise<Sent> {
  const delivery = string(record.delivery_id) || string(record.record_id), started = Date.now();
  const result = (status: number | null, error: string | null): ForwardResult => ({ at: now().toISOString(), delivery_id: delivery, status, error,
    duration_ms: Date.now() - started, event: string(record.kind), repo: string(record.repo), ...(extra['X-Sdbot-Test'] ? { test: true } : {}) });
  const problem = targetProblem(sub.url);
  if (problem) return { result: result(null, `target rejected: ${problem}`), excerpt: null };
  const headers: Record<string, string> = { 'Content-Type': contentType || 'application/json', 'User-Agent': 'sciencediscovery-bot-forward',
    'X-Sdbot-Provider': string(record.provider), 'X-Sdbot-Event': string(record.kind), 'X-Sdbot-Delivery': delivery };
  // Configured headers are added to the bot's own; reserved names are refused on save and skipped here, so they cannot replace them.
  for (const header of sub.headers || []) if (!reservedHeader(header.name.toLowerCase())) headers[header.name] = header.value;
  Object.assign(headers, extra);
  if (sub.secret) headers['X-Hub-Signature-256'] = await sign(body, sub.secret);
  try {
    const response = await fetcher(sub.url, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
    let excerpt: string | null = null;
    // Only a test shows what the target answered; credentials it may echo back are scrubbed first.
    if (readBody) excerpt = scrub(await bodyStart(response), [sub.secret, ...(sub.headers || []).map(h => h.value)], 500, true);
    else await response.body?.cancel().catch(() => undefined);
    const error = response.ok ? null : response.status >= 300 && response.status < 400 ? `redirect not followed (HTTP ${response.status})` : `HTTP ${response.status}`;
    return { result: result(response.status, error), excerpt };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return { result: result(null, name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${FORWARD_TIMEOUT_MS / 1000} s` : 'network error'), excerpt: null };
  }
}
/** One archived delivery to one target: the original body. */
export async function deliver(sub: ForwardSubscription, record: Doc, body: Uint8Array, contentType: string,
  fetcher: typeof fetch = (...args) => fetch(...args), now = () => new Date()): Promise<ForwardResult> {
  return (await send(sub, record, body, contentType, fetcher, now)).result;
}
/**
 * A test request from the admin page: a small JSON body marked with X-Sdbot-Test, sent with the
 * subscription's own URL, headers and signature but without its source, type or repository filter.
 */
export async function deliverTest(sub: ForwardSubscription, fetcher: typeof fetch = (...args) => fetch(...args), now = () => new Date()): Promise<Sent> {
  const delivery = 'test-' + crypto.randomUUID();
  const body = new TextEncoder().encode(JSON.stringify({ test: true, zen: 'sciencediscovery-bot forward test', subscription: { id: sub.id, name: sub.name }, sent_at: now().toISOString() }));
  return send(sub, { provider: 'test', kind: 'ping', delivery_id: delivery, repo: '' }, body, 'application/json', fetcher, now, { 'X-Sdbot-Test': '1' }, true);
}
/** What the admin page shows; the secret and header values are readable there and nowhere else. */
export const publicSubscription = (sub: ForwardSubscription): Doc => ({ ...sub, repos: sub.repos || [], headers: sub.headers || [],
  recent: sub.recent || (sub.last ? [sub.last] : []), has_secret: !!sub.secret });
