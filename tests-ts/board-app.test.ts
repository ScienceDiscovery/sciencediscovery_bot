import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as rsaVerify } from 'node:crypto';
import { BoardQueue, MultiBoard, type PublicationState, type StateStore } from '../src/core/board.js';
import { GitHubApp, GitHubAppAuthError, loadPrivateKey } from '../src/core/github-app.js';
import { normalize } from '../src/core/events.js';
import { object, type Doc } from '../src/core/types.js';
import { publisherEnvironment } from '../src/node/board.js';
import { FileState } from '../src/node/board.js';
import { asCurl, prepare } from '../src/node/replay.js';
import { fixture, harness, secret } from './helpers.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const commit = 'a'.repeat(40);
function memory(): StateStore & { value: Partial<PublicationState> } {
  return { value: {}, async load() { return this.value; }, async save(state) { this.value = structuredClone(state); } };
}
test('queue persists before acknowledging, coalesces, restores and separates generations', async () => {
  const state = memory(); let finish!: (commit: string) => void;
  const queue = await BoardQueue.open('a/source', 'a/board', state, () => new Promise(resolve => { finish = resolve; }));
  await queue.requestRefresh(); await queue.requestRefresh(); assert.equal(state.value.requested, 2);
  const running = queue.runOnce(); while (!finish) await Promise.resolve();
  await queue.requestRefresh(); assert.equal(await queue.runOnce(), false); finish(commit); await running;
  assert.equal(queue.status().completed, 2); assert.equal(queue.status().requested, 3); assert.equal(queue.status().pending, true);
  const restarted = await BoardQueue.open('a/source', 'a/board', state, async () => commit);
  assert.equal(restarted.status().requested, 3); await restarted.runOnce(); assert.equal(restarted.status().pending, false);
});
test('publisher failures retry without secret output and do not mark queued generation completed', async () => {
  const state = memory(); let now = 0, attempts = 0;
  const q = await BoardQueue.open('a/source', 'a/board', state, async () => { attempts++; if (attempts === 1) throw new Error('PRIVATE_KEY content'); return commit; }, 1, 60, () => now);
  await q.requestRefresh(); now = 1000; await q.tick(); assert.equal(q.status().completed, 0); assert.equal(q.status().error, 'Error');
  assert.equal(JSON.stringify(q.status()).includes('PRIVATE_KEY'), false);
  now = 30000; await q.tick(); assert.equal(attempts, 1); now = 31000; await q.tick(); assert.equal(attempts, 2); assert.equal(q.status().pending, false);
});
test('queue debounce, hourly refresh and minimum interval use injectable clock', async () => {
  let now = 0, count = 0;
  const q = await BoardQueue.open('a/source', 'a/board', memory(), async () => { count++; return commit; }, 20, 3600, () => now);
  await q.tick(); now = 19999; await q.tick(); assert.equal(count, 0); now = 20000; await q.tick(); assert.equal(count, 1);
  await q.requestRefresh(); now = 79999; await q.tick(); assert.equal(count, 1); now = 80000; await q.tick(); assert.equal(count, 2);
  now += 3600000; await q.tick(); assert.equal(q.status().pending, true); now += 20000; await q.tick(); assert.equal(count, 3);
});
test('failed queue writes are not acknowledged and separate repositories stay isolated', async () => {
  const broken = memory(); broken.save = async () => { throw new Error('disk unavailable'); };
  const q = await BoardQueue.open('a/source', 'a/board', broken, async () => commit);
  await assert.rejects(q.requestRefresh()); assert.equal(q.status().requested, 0);
  const second = await BoardQueue.open('b/source', 'b/board', memory(), async () => commit);
  const multi = new MultiBoard([q, second]);
  const event = normalize('github', new Headers({ 'x-github-event': 'issues' }), { repository: { full_name: 'B/SOURCE' } });
  assert.equal((await multi.handle('on_issue', event)).status, 'queued'); assert.equal(second.status().requested, 1); assert.equal(q.status().requested, 0);
  assert.equal((await multi.handle('on_issue', { ...event, provider: 'gitcode' })).status, 'ignored');
});
test('FileState reads legacy Python queue JSON and saves atomically', async t => {
  const h = await harness(); t.after(h.cleanup); const state = new FileState(h.directory + '/board-publication.json');
  await state.save({ requested: 8, completed: 7, last_success: null, commit: null, error: null });
  const q = await BoardQueue.open('a/source', 'a/board', new FileState(state.path), async () => commit); assert.equal(q.status().requested, 8);
  await q.runOnce(); assert.equal((await state.load()).completed, 8);
});
for (const format of ['pkcs1', 'pkcs8', 'escaped'] as const) test(`Web Crypto App JWT supports ${format}`, async () => {
  const pem = format === 'pkcs8' ? keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() : format === 'escaped' ? privateKey.replaceAll('\n', '\\n') : privateKey;
  const now = Date.now(), app = new GitHubApp('1234', pem, fetch, () => now), token = await app.jwt();
  const [header, payload, signature] = token.split('.'); assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, '1234'); assert.equal(claims.iat, Math.floor(now / 1000) - 60); assert.equal(claims.exp, Math.floor(now / 1000) + 540);
  assert.equal(rsaVerify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
});
test('RSA loader rejects malformed and non-RSA keys', async () => {
  await assert.rejects(loadPrivateKey('invalid'));
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await assert.rejects(loadPrivateKey(ec));
});
test('App looks up each organization and issues repository-scoped least-privilege tokens afresh', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options }); assert.equal(options.redirect, 'manual');
    if (String(url).endsWith('/installation')) return Response.json({ id: String(url).includes('org-a') ? 111 : 222 });
    return Response.json({ token: 'installation-token-' + calls.length, expires_at: new Date(Date.now() + 3600000).toISOString() });
  };
  const app = new GitHubApp('1234', privateKey, fetcher);
  const one = await app.tokenFor('org-a/source'), two = await app.tokenFor('org-b/board', true); assert.notEqual(one, two);
  await app.tokenFor('org-a/source'); assert.equal(calls.length, 6);
  assert.match(calls[1].url, /installations\/111/); assert.match(calls[3].url, /installations\/222/);
  const source = JSON.parse(String(calls[1].options.body)), target = JSON.parse(String(calls[3].options.body));
  assert.deepEqual(source.repositories, ['source']); assert.equal(source.permissions.actions, 'read'); assert.equal(source.permissions.contents, 'read');
  assert.deepEqual(target, { repositories: ['board'], permissions: { metadata: 'read', contents: 'write' } });
});
for (const scenario of ['http', 'expired', 'missing-token', 'suspended', 'invalid-installation']) test(`App rejects ${scenario} without disclosing response bodies`, async () => {
  const fetcher: typeof fetch = async url => {
    if (scenario === 'http') return new Response('secret-in-upstream-error', { status: 403 });
    if (String(url).endsWith('/installation')) return Response.json(scenario === 'suspended' ? { id: 123, suspended_at: 'now' } : scenario === 'invalid-installation' ? { id: true } : { id: 123 });
    return Response.json(scenario === 'missing-token' ? { expires_at: 'invalid' } : { token: 'secret-token', expires_at: new Date(Date.now() + 1000).toISOString() });
  };
  await assert.rejects(new GitHubApp('1234', privateKey, fetcher).tokenFor('a/repo'), error => error instanceof GitHubAppAuthError && !String(error).includes('secret'));
});
test('publisher environment contains only scoped tokens and safe transport settings', () => {
  const env = publisherEnvironment({ PATH: '/bin', SDBOT_GITHUB_APP_PRIVATE_KEY: 'secret-key', SDBOT_WEBHOOK_SECRET: 'secret-hook', CLOUDFLARE_TUNNEL_TOKEN: 'secret-tunnel', SDBOT_ADMIN_TOKEN: 'secret-admin', GH_TOKEN: 'personal', HTTPS_PROXY: 'http://proxy' }, 'source-token', 'publish-token');
  assert.deepEqual(Object.keys(env).sort(), ['GITHUB_TOKEN', 'GSB_PUBLISH_TOKEN', 'HTTPS_PROXY', 'PATH', 'PYTHONDONTWRITEBYTECODE']);
  assert.equal(JSON.stringify(env).includes('secret-'), false); assert.equal(JSON.stringify(env).includes('personal'), false);
});
test('replay CLI fixture preparation supports fresh/kept IDs, invalid HMAC and safe token-mode curl', async () => {
  const f = await fixture('github/issues_opened.json');
  const a = await prepare(f, { secret }), b = await prepare(f, { secret }); assert.notEqual(a.delivery, b.delivery);
  assert.equal((await prepare(f, { keepDeliveryId: true })).delivery, f.delivery);
  assert.equal((await prepare(f, { badSignature: true })).headers.get('x-hub-signature-256'), 'sha256=' + '0'.repeat(64));
  const code = await prepare(await fixture('gitcode/issue_open.json'), { secret, tokenMode: true });
  assert.equal(asCurl(code, 'http://localhost/webhook').includes(secret), false);
  assert.match(asCurl(code, 'http://localhost/webhook'), /SDBOT_GITCODE_WEBHOOK_SECRET/);
});

test('Actions queue persists dispatch acknowledgement without claiming a Pages commit', async () => {
  const state = memory(); let calls = 0;
  const queue = await BoardQueue.open('a/source', 'a/board', state, async generation => {
    calls++; assert.equal(generation, 2); return { dispatched: true };
  }, 20, 3600, undefined, 'github_actions');
  await queue.requestRefresh(); await queue.requestRefresh(); await queue.runOnce();
  assert.equal(calls, 1); assert.equal(queue.status().execution, 'github_actions');
  assert.equal(queue.status().pending, false); assert.equal(queue.status().commit, null);
  assert.equal(queue.status().last_success, null); assert.ok(queue.status().last_dispatch);
  const restarted = await BoardQueue.open('a/source', 'a/board', state, async () => { throw new Error('not due'); }, 20, 3600, undefined, 'github_actions');
  assert.equal(restarted.status().completed, 2);
  assert.equal(restarted.status().last_dispatch, queue.status().last_dispatch);
});

test('Node Actions adapter needs no Python source and requests only target Actions permission', async t => {
  const { createBoards } = await import('../src/node/board.js');
  const h = await harness({ board_execution: 'github_actions', board_source_dir: 'does-not-exist',
    board_targets: { 'ScienceDiscovery/sciencediscovery': 'ScienceDiscovery/github-status-board-test' },
    github_app_id: '1234', github_app_private_key: privateKey });
  t.after(h.cleanup);
  const calls: {url: string; options: RequestInit}[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url: String(url), options});
    if (String(url).endsWith('/installation')) return Response.json({id: 123});
    if (String(url).endsWith('/access_tokens')) return Response.json({token: 'isolated-dispatch-token', expires_at: new Date(Date.now()+3600000).toISOString()});
    return new Response(null, {status: 204});
  };
  const boards = await createBoards(h.cfg);
  await boards.queues[0].requestRefresh(); await boards.queues[0].runOnce();
  assert.deepEqual(JSON.parse(String(calls[1].options.body)).permissions, {metadata: 'read', actions: 'write'});
  assert.match(calls[2].url, /github-status-board-test\/actions\/workflows\/collect.yml\/dispatches$/);
  assert.equal(JSON.parse(String(calls[2].options.body)).inputs.source_repository, 'ScienceDiscovery/sciencediscovery');
  assert.equal(boards.queues[0].status().commit, null);
  assert.ok(boards.queues[0].status().last_dispatch);
  assert.equal((await createBoards(h.cfg)).queues[0].status().completed, 1);
});
