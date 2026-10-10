/**
 * Minimal Git smart-HTTP client built on standard Fetch and streams, so the same
 * code runs in Node and in Workers. It copies one commit between two hosts while
 * keeping its SHA: GitHub's upload-pack (protocol v2) produces a self-contained
 * pack, which is streamed unchanged into GitCode's receive-pack. Packfiles are
 * never parsed or buffered whole. Every ref update names the old SHA the
 * receiver advertised, so nothing here force-pushes; deleting a branch is a
 * separate command without a pack.
 */
import { scrub } from './redact.js';
import { utf8 } from './types.js';

export const ZERO_SHA = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder();

export class GitTransferError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null, readonly transient = false) { super(message); }
}
export interface GitRemote { url: string; authorization: string }
export interface PushResult { status: 'pushed' | 'unchanged'; old: string; new: string; ref: string }
export interface DeleteResult { status: 'deleted' | 'absent'; old: string; ref: string }
type Fetcher = typeof fetch;

export function pktLine(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const payload = typeof value === 'string' ? utf8.encode(value) : value;
  if (payload.length > 65516) throw new RangeError('pkt-line payload too large');
  const out = new Uint8Array(payload.length + 4);
  out.set(utf8.encode((payload.length + 4).toString(16).padStart(4, '0')));
  out.set(payload, 4);
  return out;
}
export const FLUSH = utf8.encode('0000');
const DELIM = utf8.encode('0001');
const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

export type Packet = { kind: 'data'; payload: Uint8Array } | { kind: 'flush' | 'delim' | 'end' };
/** Incremental pkt-line reader over a response body. */
export class PacketReader {
  private buffer = new Uint8Array(0);
  private done = false;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}
  private async fill(size: number): Promise<boolean> {
    while (this.buffer.length < size && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) this.done = true; else if (value?.length) this.buffer = concat([this.buffer, value]);
    }
    return this.buffer.length >= size;
  }
  /** null means the stream ended cleanly between packets. */
  async next(): Promise<Packet | null> {
    if (!await this.fill(4)) {
      if (this.buffer.length) throw new GitTransferError('protocol_error', 'truncated pkt-line header');
      return null;
    }
    const header = decoder.decode(this.buffer.subarray(0, 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new GitTransferError('protocol_error', 'invalid pkt-line header');
    const length = parseInt(header, 16);
    if (length < 4) { this.buffer = this.buffer.subarray(4); return { kind: length === 0 ? 'flush' : length === 1 ? 'delim' : 'end' }; }
    if (!await this.fill(length)) throw new GitTransferError('protocol_error', 'truncated pkt-line payload');
    const payload = this.buffer.slice(4, length);
    this.buffer = this.buffer.subarray(length);
    return { kind: 'data', payload };
  }
  cancel(): Promise<void> { return this.reader.cancel().catch(() => undefined); }
}
const line = (payload: Uint8Array): string => decoder.decode(payload).replace(/\n$/, '');
/** Server text can echo request details; redact, then keep it short and single-line. */
const serverText = (value: string): string => scrub(value, [], 160).trim();

function httpFailure(service: string, status: number): GitTransferError {
  if (status === 401 || status === 403) return new GitTransferError('permission_denied', `${service} returned HTTP ${status}: credentials rejected or missing permission`, status);
  if (status === 404) return new GitTransferError('repository_not_found', `${service} returned HTTP 404: repository not found or not visible to the credentials`, status);
  return new GitTransferError('git_http_error', `${service} returned HTTP ${status}`, status, status === 429 || status >= 500);
}
async function call(fetcher: Fetcher, service: string, url: string, init: RequestInit & { duplex?: 'half' }, timeout: number): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) }); }
  catch { throw new GitTransferError('network_error', `${service} request failed before a response`, null, true); }
  if (!response.ok) { await response.body?.cancel(); throw httpFailure(service, response.status); }
  if (!response.body) throw new GitTransferError('protocol_error', `${service} returned an empty body`);
  return response;
}
const repoUrl = (remote: GitRemote, suffix: string): string => remote.url.replace(/\/+$/, '') + suffix;
const headers = (remote: GitRemote, extra: Record<string, string>): Record<string, string> =>
  ({ ...extra, Authorization: remote.authorization, 'User-Agent': 'git/2.43.0 sciencediscovery-bot' });

/** Skip the optional "# service=..." preamble that smart HTTP adds to info/refs. */
async function afterServiceHeader(reader: PacketReader): Promise<Packet | null> {
  const first = await reader.next();
  if (first?.kind === 'data' && line(first.payload).startsWith('# service=')) {
    const flush = await reader.next();
    if (flush?.kind !== 'flush') throw new GitTransferError('protocol_error', 'malformed service advertisement');
    return reader.next();
  }
  return first;
}

export interface ReceiveAdvertisement { refs: Map<string, string>; capabilities: Set<string> }
export async function receiveRefs(remote: GitRemote, fetcher: Fetcher = (...args) => fetch(...args)): Promise<ReceiveAdvertisement> {
  const response = await call(fetcher, 'GitCode receive-pack advertisement', repoUrl(remote, '/info/refs?service=git-receive-pack'), { method: 'GET', headers: headers(remote, { Accept: '*/*' }) }, 30000);
  const reader = new PacketReader(response.body!.getReader());
  const refs = new Map<string, string>(); let capabilities = new Set<string>();
  try {
    for (let packet = await afterServiceHeader(reader); packet && packet.kind !== 'flush'; packet = await reader.next()) {
      if (packet.kind !== 'data') continue;
      let text = line(packet.payload);
      if (text.startsWith('ERR ')) throw new GitTransferError('git_remote_error', 'GitCode refused the advertisement: ' + serverText(text.slice(4)));
      const nul = text.indexOf('\0');
      if (nul >= 0) { capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean)); text = text.slice(0, nul); }
      const [sha, ref] = text.split(' ');
      if (SHA.test(sha) && ref && ref !== 'capabilities^{}') refs.set(ref, sha);
    }
  } finally { await reader.cancel(); }
  return { refs, capabilities };
}

/**
 * The SHA a single ref points at, read from upload-pack: protocol v2 `ls-refs` limited to that ref when the
 * host offers it, otherwise the v0 advertisement. Read-only; null when the ref does not exist.
 */
export async function remoteRef(remote: GitRemote, ref: string, fetcher: Fetcher = (...args) => fetch(...args)): Promise<string | null> {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..') || ref.endsWith('/')) throw new GitTransferError('invalid_ref', 'unsafe ref name');
  const advertised = await call(fetcher, 'upload-pack advertisement', repoUrl(remote, '/info/refs?service=git-upload-pack'),
    { method: 'GET', headers: headers(remote, { Accept: '*/*', 'Git-Protocol': 'version=2' }) }, 30000);
  const ads = new PacketReader(advertised.body!.getReader());
  let v2 = false, lsRefs = false;
  const v0 = new Map<string, string>();
  try {
    for (let packet = await afterServiceHeader(ads); packet && packet.kind !== 'flush'; packet = await ads.next()) {
      if (packet.kind !== 'data') continue;
      let text = line(packet.payload);
      if (text.startsWith('ERR ')) throw new GitTransferError('git_remote_error', 'the host refused the advertisement: ' + serverText(text.slice(4)));
      if (text === 'version 2') { v2 = true; continue; }
      if (v2) { if (text === 'ls-refs' || text.startsWith('ls-refs=')) lsRefs = true; continue; }
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const [sha, name] = text.split(' ');
      if (SHA.test(sha) && name) v0.set(name, sha);
    }
  } finally { await ads.cancel(); }
  if (!v2) return v0.get(ref) ?? null;
  if (!lsRefs) throw new GitTransferError('protocol_unsupported', 'upload-pack v2 does not offer ls-refs');
  const body = concat([pktLine('command=ls-refs\n'), DELIM, pktLine(`ref-prefix ${ref}\n`), FLUSH]);
  const response = await call(fetcher, 'upload-pack ls-refs', repoUrl(remote, '/git-upload-pack'), { method: 'POST', body,
    headers: headers(remote, { 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result', 'Git-Protocol': 'version=2' }) }, 30000);
  const reader = new PacketReader(response.body!.getReader());
  try {
    for (let packet = await reader.next(); packet && packet.kind !== 'flush'; packet = await reader.next()) {
      if (packet.kind !== 'data') continue;
      const [sha, name] = line(packet.payload).split(' ');
      if (name === ref && SHA.test(sha)) return sha;
    }
  } finally { await reader.cancel(); }
  return null;
}

/** Ask upload-pack v2 for `want` and return only the raw pack bytes (side-band 1). */
export async function fetchPack(remote: GitRemote, want: string, haves: readonly string[], fetcher: Fetcher = (...args) => fetch(...args)): Promise<ReadableStream<Uint8Array>> {
  if (!SHA.test(want)) throw new GitTransferError('invalid_sha', 'wanted object is not a full SHA-1');
  const advertised = await call(fetcher, 'GitHub upload-pack advertisement', repoUrl(remote, '/info/refs?service=git-upload-pack'),
    { method: 'GET', headers: headers(remote, { Accept: '*/*', 'Git-Protocol': 'version=2' }) }, 30000);
  const ads = new PacketReader(advertised.body!.getReader());
  let v2 = false, fetchCommand = false;
  try {
    for (let packet = await afterServiceHeader(ads); packet && packet.kind !== 'flush'; packet = await ads.next()) {
      if (packet.kind !== 'data') continue;
      const text = line(packet.payload);
      if (text === 'version 2') v2 = true;
      if (text === 'fetch' || text.startsWith('fetch=')) fetchCommand = true;
    }
  } finally { await ads.cancel(); }
  if (!v2 || !fetchCommand) throw new GitTransferError('protocol_unsupported', 'GitHub upload-pack did not offer protocol v2 fetch');
  // No thin-pack/ofs-delta: the pack must be self-contained for any receiver.
  const body = concat([pktLine('command=fetch\n'), DELIM, pktLine('no-progress\n'), pktLine(`want ${want}\n`),
    ...[...new Set(haves)].filter(sha => SHA.test(sha) && sha !== ZERO_SHA).slice(0, 256).map(sha => pktLine(`have ${sha}\n`)), pktLine('done\n'), FLUSH]);
  const response = await call(fetcher, 'GitHub upload-pack', repoUrl(remote, '/git-upload-pack'), { method: 'POST', body,
    headers: headers(remote, { 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result', 'Git-Protocol': 'version=2' }) }, 600000);
  const reader = new PacketReader(response.body!.getReader());
  // Sections before "packfile" (shallow-info, wanted-refs, packfile-uris) are not requested.
  for (;;) {
    const packet = await reader.next();
    if (!packet || packet.kind !== 'data') { await reader.cancel(); throw new GitTransferError('protocol_error', 'GitHub upload-pack ended without a packfile'); }
    const text = line(packet.payload);
    if (text.startsWith('ERR ')) { await reader.cancel(); throw new GitTransferError('object_unavailable', 'GitHub could not serve the commit: ' + serverText(text.slice(4))); }
    if (text === 'packfile') break;
    if (text === 'acknowledgments') { await reader.cancel(); throw new GitTransferError('protocol_error', 'GitHub upload-pack negotiated instead of sending the pack'); }
  }
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const packet = await reader.next();
          if (!packet || packet.kind === 'flush' || packet.kind === 'end') {
            if (!started) throw new GitTransferError('protocol_error', 'GitHub upload-pack sent an empty packfile section');
            controller.close(); return;
          }
          if (packet.kind !== 'data' || !packet.payload.length) continue;
          const band = packet.payload[0], data = packet.payload.subarray(1);
          if (band === 1) {
            if (!started && decoder.decode(data.subarray(0, 4)) !== 'PACK') throw new GitTransferError('protocol_error', 'GitHub upload-pack data is not a packfile');
            started = true; controller.enqueue(data); return;
          }
          if (band === 3) throw new GitTransferError('object_unavailable', 'GitHub upload-pack failed: ' + serverText(decoder.decode(data)));
        }
      } catch (error) { await reader.cancel(); controller.error(error); }
    },
    cancel() { return reader.cancel(); },
  });
}

async function report(response: Response, ref: string): Promise<void> {
  const reader = new PacketReader(response.body!.getReader());
  let unpacked = false, updated = false;
  try {
    for (let packet = await reader.next(); packet && packet.kind !== 'flush'; packet = await reader.next()) {
      if (packet.kind !== 'data') continue;
      const text = line(packet.payload);
      if (text === 'unpack ok') unpacked = true;
      else if (text.startsWith('unpack ')) throw new GitTransferError('push_rejected', 'GitCode could not unpack the pushed objects: ' + serverText(text.slice(7)));
      else if (text === `ok ${ref}`) updated = true;
      else if (text.startsWith(`ng ${ref} `)) {
        const reason = serverText(text.slice(ref.length + 4));
        throw new GitTransferError(/non-fast-forward|fetch first/i.test(reason) ? 'not_fast_forward' : 'push_rejected', `GitCode rejected ${ref}: ` + reason);
      }
      else if (text.startsWith('ERR ')) throw new GitTransferError('push_rejected', 'GitCode refused the push: ' + serverText(text.slice(4)));
    }
  } finally { await reader.cancel(); }
  if (!unpacked || !updated) throw new GitTransferError('push_rejected', 'GitCode did not confirm the branch update');
}

const safeBranchRef = (ref: string): boolean => /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes('..') && !ref.endsWith('/') && !ref.endsWith('.lock');

/**
 * Make `target` ref point at `sha` on the receiving host, copying objects from
 * the source host. Haves are commits the receiver already holds; the sender
 * omits whatever it can prove is common, and sends the full history otherwise.
 * With `fastForward`, the advertised old SHA must exist and the callback must
 * confirm it is an ancestor of `sha`; the update still names that old SHA.
 */
export async function pushCommit(options: { source: GitRemote; target: GitRemote; sha: string; ref: string; haves?: readonly string[]; fetcher?: Fetcher;
  fastForward?: (old: string) => Promise<boolean> }): Promise<PushResult> {
  const { source, target, sha, ref } = options, fetcher = options.fetcher || ((...args) => fetch(...args));
  if (!SHA.test(sha)) throw new GitTransferError('invalid_sha', 'head is not a full SHA-1');
  if (!safeBranchRef(ref)) throw new GitTransferError('invalid_ref', 'unsafe branch name');
  const advertisement = await receiveRefs(target, fetcher);
  const old = advertisement.refs.get(ref) || ZERO_SHA;
  if (old === sha) return { status: 'unchanged', old, new: sha, ref };
  if (options.fastForward && (old === ZERO_SHA || !await options.fastForward(old)))
    throw new GitTransferError('not_fast_forward', `${ref} is at ${old.slice(0, 7)}, which ${sha.slice(0, 7)} does not contain; only fast-forward updates are allowed`);
  if (!advertisement.capabilities.has('report-status')) throw new GitTransferError('protocol_unsupported', 'GitCode receive-pack does not report push status');
  const pack = await fetchPack(source, sha, [...advertisement.refs.values(), ...(options.haves || [])], fetcher);
  const command = concat([pktLine(`${old} ${sha} ${ref}\0report-status\n`), FLUSH]);
  const packReader = pack.getReader();
  let sentCommand = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentCommand) { sentCommand = true; controller.enqueue(command); return; }
      try {
        const { value, done } = await packReader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel() { return packReader.cancel(); },
  });
  let response: Response;
  try {
    response = await call(fetcher, 'GitCode receive-pack', repoUrl(target, '/git-receive-pack'), { method: 'POST', body, duplex: 'half',
      headers: headers(target, { 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }) }, 600000);
  } catch (error) { await packReader.cancel().catch(() => undefined); throw error; }
  await report(response, ref);
  return { status: 'pushed', old, new: sha, ref };
}

/** Delete `ref` on the receiving host: advertised old SHA → zero, no pack. A missing branch is already done. */
export async function deleteRef(options: { target: GitRemote; ref: string; fetcher?: Fetcher }): Promise<DeleteResult> {
  const { target, ref } = options, fetcher = options.fetcher || ((...args) => fetch(...args));
  if (!safeBranchRef(ref)) throw new GitTransferError('invalid_ref', 'unsafe branch name');
  const advertisement = await receiveRefs(target, fetcher);
  const old = advertisement.refs.get(ref);
  if (!old) return { status: 'absent', old: ZERO_SHA, ref };
  if (!advertisement.capabilities.has('report-status') || !advertisement.capabilities.has('delete-refs')) throw new GitTransferError('protocol_unsupported', 'GitCode receive-pack does not allow reported branch deletion');
  const body = concat([pktLine(`${old} ${ZERO_SHA} ${ref}\0report-status delete-refs\n`), FLUSH]);
  const response = await call(fetcher, 'GitCode receive-pack', repoUrl(target, '/git-receive-pack'), { method: 'POST', body,
    headers: headers(target, { 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }) }, 60000);
  await report(response, ref);
  return { status: 'deleted', old, ref };
}

export const basicAuthorization = (username: string, password: string): string => {
  const bytes = utf8.encode(`${username}:${password}`); let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'Basic ' + btoa(binary);
};
