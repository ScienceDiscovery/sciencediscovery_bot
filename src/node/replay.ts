import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sign } from '../core/signature.js';
import { jsonBytes, object, string, type Doc } from '../core/types.js';

export interface ReplayOptions { secret?: string; noSignature?: boolean; badSignature?: boolean; tokenMode?: boolean; keepDeliveryId?: boolean; }
export async function prepare(fixture: Doc, options: ReplayOptions = {}): Promise<{ provider: string; delivery: string; body: Uint8Array<ArrayBuffer>; headers: Headers }> {
  const provider = string(fixture.provider), event = string(fixture.event);
  if (!['github', 'gitcode'].includes(provider) || !event || !fixture.payload) throw new TypeError('invalid fixture');
  const delivery = (options.keepDeliveryId && string(fixture.delivery)) || `replay-${crypto.randomUUID()}`;
  const body = jsonBytes(fixture.payload), headers = new Headers({ 'content-type': 'application/json', [`x-${provider}-event`]: event, [`x-${provider}-delivery`]: delivery });
  if (provider === 'github') {
    headers.set('user-agent', 'GitHub-Hookshot/replay'); headers.set('x-github-hook-id', '555001');
    headers.set('x-github-hook-installation-target-type', 'integration'); headers.set('x-github-hook-installation-target-id', '987654');
  } else headers.set('user-agent', 'GitCode-Hookshot/replay');
  if (provider === 'gitcode' && options.tokenMode && options.secret && !options.noSignature) headers.set('x-gitcode-token', options.badSignature ? 'wrong-token' : options.secret);
  else if (options.badSignature || (!options.noSignature && options.secret)) headers.set(provider === 'github' ? 'x-hub-signature-256' : 'x-gitcode-signature-256', options.badSignature ? 'sha256=' + '0'.repeat(64) : await sign(body, options.secret!));
  return { provider, delivery, body, headers };
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function asCurl(prepared: Awaited<ReturnType<typeof prepare>>, url: string, secretEnv?: string): string {
  if (secretEnv && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(secretEnv)) throw new TypeError('invalid environment variable');
  const headers = [...prepared.headers].map(([key, value]) => key === 'x-gitcode-token'
    ? '-H "X-GitCode-Token: ${' + (secretEnv || 'SDBOT_GITCODE_WEBHOOK_SECRET:-${SDBOT_WEBHOOK_SECRET:?Set webhook secret}') + '}"'
    : '-H ' + quote(`${key}: ${value}`));
  return `printf '%s' ${quote(new TextDecoder().decode(prepared.body))} | curl -sS -X POST ${quote(url)} ${headers.join(' ')} --data-binary @-`;
}
async function collect(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await collect(join(directory, entry.name)));
    else if (entry.name.endsWith('.json')) result.push(join(directory, entry.name));
  }
  return result.sort();
}
async function main(): Promise<void> {
  const args = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const all = args.indexOf('--all');
  if (all >= 0 && (!args[all + 1] || args[all + 1].startsWith('-'))) args.splice(all + 1, 0, join(root, 'fixtures'));
  const { values: opts, positionals } = parseArgs({ args, allowPositionals: true, options: {
    all: { type: 'string' }, url: { type: 'string', default: process.env.SDBOT_REPLAY_URL || 'http://127.0.0.1:8791/webhook' },
    'admin-url': { type: 'string', default: process.env.SDBOT_REPLAY_ADMIN_URL ?? 'http://127.0.0.1:8792' }, 'secret-env': { type: 'string' },
    'no-signature': { type: 'boolean' }, 'bad-signature': { type: 'boolean' }, 'token-mode': { type: 'boolean' },
    'keep-delivery-id': { type: 'boolean' }, 'print-curl': { type: 'boolean' }, expect: { type: 'string' }, timeout: { type: 'string', default: '10' },
  } });
  const files = opts.all !== undefined ? await collect(opts.all) : positionals;
  if (!files.length) throw new TypeError('pass fixture paths or --all');
  let passed = 0;
  for (const file of files) {
    const fixture = object(JSON.parse(await readFile(file, 'utf8')));
    const secret = opts['secret-env'] ? process.env[opts['secret-env']] : process.env[`SDBOT_${string(fixture.provider).toUpperCase()}_WEBHOOK_SECRET`] || process.env.SDBOT_WEBHOOK_SECRET;
    const prepared = await prepare(fixture, { secret, noSignature: opts['no-signature'], badSignature: opts['bad-signature'], tokenMode: opts['token-mode'], keepDeliveryId: opts['keep-delivery-id'] });
    if (opts['print-curl']) { console.log(asCurl(prepared, opts.url!, opts['secret-env'])); continue; }
    const expected = Number(opts.expect || (secret && (opts['bad-signature'] || opts['no-signature']) ? 401 : 200));
    const response = await fetch(opts.url!, { method: 'POST', headers: prepared.headers, body: prepared.body, signal: AbortSignal.timeout(Number(opts.timeout) * 1000), redirect: 'error' });
    await response.body?.cancel();
    let record: Doc = {};
    if (opts['admin-url']) try {
      const url = new URL('/api/events', opts['admin-url']); url.searchParams.set('limit', '1'); url.searchParams.set('delivery_id', prepared.delivery);
      const response = await fetch(url, { headers: process.env.SDBOT_ADMIN_TOKEN ? { Authorization: 'Bearer ' + process.env.SDBOT_ADMIN_TOKEN } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' });
      const result = object(await response.json()); record = object(Array.isArray(result.events) ? result.events[0] : null);
    } catch { /* admin is optional */ }
    if (response.status === expected) passed++;
    console.log(`${response.status === expected ? 'OK' : 'BAD'} ${response.status} ${prepared.provider} ${string(record.route) || '(admin unavailable)'} hooks=${JSON.stringify(record.hooks || [])}${record.duplicate ? ' DUPLICATE' : ''}`);
  }
  if (!opts['print-curl']) { console.log(`${passed}/${files.length} deliveries answered as expected`); if (passed !== files.length) process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => { console.error('replay failed: check fixture, endpoint and environment'); process.exitCode = 1; });
