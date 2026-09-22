import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { configFromEnv, tracks, validateConfig } from '../src/core/config.js';
import { normalize } from '../src/core/events.js';
import { EventBus, Router, glob } from '../src/core/bus.js';
import { detectProvider, sign, verify } from '../src/core/signature.js';
import { eventSummary, jsonBytes, object, type BotEvent, type Doc } from '../src/core/types.js';
import { delivery, fixture, harness, secret } from './helpers.js';

const golden = JSON.parse(await readFile('tests-ts/fixtures/expected-events.json', 'utf8')) as Record<string, { event: Doc; hooks: string[]; handled: boolean }>;
for (const [name, expected] of Object.entries(golden)) test(`legacy event parity: ${name}`, async () => {
  const f = await fixture(name), provider = String(f.provider);
  const event = normalize(provider, new Headers({ [`x-${provider}-event`]: String(f.event), [`x-${provider}-delivery`]: String(f.delivery || '') }), object(f.payload));
  assert.deepEqual(eventSummary(event), expected.event);
  const result = await new Router().dispatch(event);
  assert.deepEqual(result.hooks, expected.hooks); assert.equal(result.handled, expected.handled);
});
test('GitHub HMAC checks exact UTF-8 bytes and never accepts SHA1 or wrong secret', async () => {
  const body = jsonBytes({ body: '中文🚀' });
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(await sign(body, secret), expected);
  const headers = new Headers({ 'X-Hub-Signature-256': expected });
  assert.equal((await verify('github', headers, body, secret)).ok, true);
  assert.equal((await verify('github', headers, jsonBytes({ body: 'changed' }), secret)).ok, false);
  assert.equal((await verify('github', new Headers({ 'X-Hub-Signature': 'sha1=123' }), body, secret)).ok, false);
  headers.set('X-Hub-Signature-256', expected.toUpperCase());
  assert.equal((await verify('github', headers, body, secret)).ok, false);
});
test('GitCode supports hex/base64/token and bad signature cannot fall back to valid token', async () => {
  const body = jsonBytes({ hello: '中文' });
  for (const signature of [await sign(body, secret), 'sha256=' + createHmac('sha256', secret).update(body).digest('base64')]) {
    assert.equal((await verify('gitcode', new Headers({ 'X-GitCode-Signature-256': signature }), body, secret)).ok, true);
  }
  assert.equal((await verify('gitcode', new Headers({ 'X-GitCode-Signature-256': createHmac('sha256', secret).update(body).digest('base64') }), body, secret)).ok, false);
  const headers = new Headers({ 'X-GitCode-Token': secret });
  assert.equal((await verify('gitcode', headers, body, secret)).ok, true);
  headers.set('X-GitCode-Signature-256', 'wrong');
  assert.equal((await verify('gitcode', headers, body, secret)).ok, false);
  assert.equal((await verify('gitcode', new Headers({ 'X-GitCode-Token': 'wrong' }), body, secret)).ok, false);
});
test('unsigned is explicit and provider detection does not infer GitLab', async () => {
  assert.equal((await verify('github', new Headers(), new Uint8Array())).mode, 'unsigned');
  assert.equal(detectProvider(new Headers({ 'X-Gitlab-Event': 'Push Hook' })), '');
  assert.equal(detectProvider(new Headers({ 'X-GitHub-Event': 'ping', 'X-GitCode-Event': 'Push Hook' })), 'github');
});
test('event names that match Object prototype properties remain unknown', () => {
  for (const value of ['constructor', '__proto__', 'toString']) {
    const e = normalize('github', new Headers({ 'x-github-event': value }), {});
    assert.equal(e.kind, 'unknown'); assert.equal(eventSummary(e).route, `unknown.${value}`);
    assert.equal(normalize('gitcode', new Headers({ 'x-gitcode-event': 'Issue Hook' }), { object_attributes: { action: value } }).action, value);
  }
});
for (const repos of ['', ' ', ',,,']) test(`blank repository allowlist remains restricted (${JSON.stringify(repos)})`, () => {
  const cfg = configFromEnv({ SDBOT_REPOS: repos });
  assert.equal(tracks(cfg, 'OPENJIUWEN-AI/SCIENCEDISCOVERY'), true);
  assert.equal(tracks(cfg, 'other/repo'), false); assert.equal(tracks(cfg, 'ScienceDiscovery/sciencediscovery', 'gitcode'), false);
});
test('configuration rejects unsafe listeners and conflicting publisher targets', () => {
  const cfg = configFromEnv(); cfg.webhook_host = '0.0.0.0'; assert.ok(validateConfig(cfg).length);
  cfg.allow_non_loopback = true; cfg.admin_port = cfg.webhook_port; cfg.admin_host = cfg.webhook_host; assert.ok(validateConfig(cfg).length);
  cfg.admin_port = 8792; cfg.board_targets = { 'other/repo': 'other/repo' }; assert.ok(validateConfig(cfg).length >= 2);
});
const event = (): BotEvent => normalize('github', new Headers({ 'x-github-event': 'issues' }), { action: 'opened', repository: { full_name: 'owner/repo' } });
test('bus selectors, excludes, disabled listeners and registry validation', async () => {
  const bus = new EventBus(), calls: string[] = [];
  const base = { id: 'one', business: 'test', description: 'test', routes: ['issue.*'], handler: () => { calls.push('one'); } };
  bus.subscribe({ ...base, providers: ['github'], repositories: ['OWNER/REPO'] });
  bus.subscribe({ ...base, id: 'excluded', exclude: ['*.opened'] });
  bus.subscribe({ ...base, id: 'disabled', enabled: false });
  bus.subscribe({ ...base, id: 'wrong-provider', providers: ['gitcode'] });
  assert.throws(() => bus.subscribe(base)); assert.throws(() => bus.subscribe({ ...base, id: 'bad', routes: [] }));
  const result = await bus.dispatch(event()); assert.deepEqual(calls, ['one']); assert.equal(result.listeners.length, 1);
  assert.equal(bus.inventory().find(l => l.id === 'disabled')?.mode, 'disabled');
  assert.equal(JSON.stringify(bus.inventory()).includes('handler'), false);
  assert.equal(glob('issue.opened', 'issue.[or]pene?'), true); assert.equal(glob('issue.closed', 'issue.[!c]*'), false);
});
test('bus isolates errors/mutations and applies registrations only to the next dispatch', async () => {
  const bus = new EventBus(); let registered = false, received = '';
  bus.subscribe({ id: 'broken', business: 'test', description: 'test', routes: ['*'], handler: e => { e.repo = 'corrupted'; throw new Error('secret-value'); } });
  bus.subscribe({ id: 'register', business: 'test', description: 'test', routes: ['*'], handler: e => {
    received = e.repo;
    if (!registered) { registered = true; bus.subscribe({ id: 'late', business: 'test', description: 'test', routes: ['*'], handler: () => ({ status: 'queued' }) }); }
  } });
  const result = await bus.dispatch(event()); assert.equal(received, 'owner/repo'); assert.equal(result.listeners.length, 2);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal((await bus.dispatch(event())).listeners.length, 3);
});
test('protocol ping and installation do not run custom businesses; unknown events may subscribe', async () => {
  const router = new Router(); let calls = 0;
  router.bus.subscribe({ id: 'custom', business: 'test', description: 'test', routes: ['*'], handler: () => { calls++; } });
  for (const kind of ['ping', 'installation']) await router.dispatch({ ...event(), kind });
  assert.equal(calls, 0);
  await router.dispatch({ ...event(), kind: 'unknown', raw_event: 'star' }); assert.equal(calls, 1);
});
test('concurrent duplicate deliveries invoke listeners once and archive every attempt', async t => {
  const h = await harness(); t.after(h.cleanup); const d = await delivery('issues', undefined, { delivery: 'same' });
  let calls = 0; h.router.bus.subscribe({ id: 'custom', business: 'test', description: 'test', routes: ['issue.*'], handler: async () => { await new Promise(r => setTimeout(r, 5)); calls++; } });
  const replies = await Promise.all(Array.from({ length: 12 }, () => h.pipeline.receive(d.headers, d.body)));
  assert.equal(calls, 1); assert.equal(replies.filter(r => r.record.duplicate).length, 11); assert.equal((await h.store.recent(50)).length, 12);
  assert.equal(new Set(replies.map(r => r.record.record_id)).size, 12);
});
test('ignored repositories and unknown events are archived with minimal 2xx', async t => {
  const h = await harness(); t.after(h.cleanup);
  const d = await delivery('issues', { action: 'opened', repository: { full_name: 'other/repo' } });
  const ignored = await h.pipeline.receive(d.headers, d.body); assert.equal(ignored.record.status, 'ignored'); assert.deepEqual(ignored.record.hooks, []);
  const unknown = await delivery('star', { repository: { full_name: 'ScienceDiscovery/sciencediscovery' } });
  const result = await h.pipeline.receive(unknown.headers, unknown.body); assert.equal(result.status, 200); assert.equal(result.record.handled, false);
  assert.deepEqual(Object.keys(result.body).sort(), ['delivery_id', 'ok']);
});
for (const invalid of ['[]', 'null', 'true', '{broken', '\uFFFD']) test(`invalid body is archived and rejected: ${invalid}`, async t => {
  const h = await harness(); t.after(h.cleanup); const body = new TextEncoder().encode(invalid), headers = new Headers({ 'x-github-event': 'ping', 'x-hub-signature-256': await sign(body, secret) });
  const reply = await h.pipeline.receive(headers, body); assert.equal(reply.status, 400); assert.equal((await h.store.recent(5)).length, 1);
});
