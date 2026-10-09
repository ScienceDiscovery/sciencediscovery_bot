import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { accessFixture } from './support/access.mjs';

const GITHUB_SECRET = 'forward-github-secret', GITCODE_SECRET = 'forward-gitcode-secret';
const github = (event, payload, delivery = randomUUID(), secret = GITHUB_SECRET) => {
  const body = JSON.stringify(payload);
  return { delivery, body, init: { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } } };
};
const repository = { full_name: 'openJiuwen-ai/sciencediscovery' };
const until = async (check, ms = 9000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 50)); }
};

test('forwarding sends verified, archived deliveries to matching HTTPS targets only', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-forward-'));
  const access = await accessFixture();
  const received = [];
  const mf = await workerRuntime({ directory, bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET, SDBOT_GITCODE_WEBHOOK_SECRET: GITCODE_SECRET,
    SDBOT_REPOS: 'openJiuwen-ai/sciencediscovery', SDBOT_ENVIRONMENT: 'test' },
  outboundService: async request => {
    const jwks = access.jwks(request); if (jwks) return jwks;
    const url = new URL(request.url);
    received.push({ url: request.url, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
    if (url.hostname === 'broken.example') return new Response('no', { status: 500 });
    if (url.hostname === 'redirect.example') return new Response(null, { status: 302, headers: { location: 'https://a.example/redirected' } });
    if (url.hostname === 'slow.example') return new Promise(() => {});
    return new Response('ok');
  } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = (path, options) => access.admin(mf, path, options);
  const json = async response => ({ status: response.status, body: await response.json() });
  const create = async (fields) => json(await admin('/admin/api/forwards', { method: 'POST', body: { types: ['issue'], providers: ['github'], ...fields } }));
  const to = path => received.filter(r => r.url === 'https://a.example' + path);

  await t.test('targets must be public HTTPS addresses', async () => {
    for (const url of ['http://a.example/hook', 'https://127.0.0.1/hook', 'https://2130706433/hook', 'https://10.1.2.3/', 'https://172.20.0.1/', 'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/', 'https://0.0.0.0/', 'https://[::1]/', 'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[::ffff:10.0.0.1]/',
      'https://localhost/', 'https://api.localhost/', 'https://metadata.google.internal/', 'https://user:pass@a.example/', 'ftp://a.example/']) {
      const result = await create({ name: 'rejected', url });
      assert.equal(result.status, 422, url);
      assert.match(result.body.error, /target URL rejected/, url);
    }
    assert.equal((await create({ name: 'no types', url: 'https://a.example/x', types: [] })).status, 422);
    assert.equal((await create({ name: 'bad provider', url: 'https://a.example/x', providers: ['gitlab'] })).status, 422);
  });

  const subs = {};
  await t.test('subscriptions are created and read back with their secret', async () => {
    for (const [key, fields] of Object.entries({
      issues: { name: 'Issues', url: 'https://a.example/issues', secret: 'forward-target-secret' },
      gitcodePush: { name: 'GitCode push', url: 'https://a.example/gitcode-push', providers: ['gitcode'], types: ['push'] },
      other: { name: 'Everything else', url: 'https://a.example/other', providers: ['github', 'gitcode'], types: ['other'] },
      broken: { name: 'Broken', url: 'https://broken.example/hook' },
      redirect: { name: 'Redirect', url: 'https://redirect.example/hook' },
      slow: { name: 'Slow', url: 'https://slow.example/hook' },
    })) {
      const result = await create(fields);
      assert.equal(result.status, 201, key);
      subs[key] = result.body.subscription.id;
    }
    const list = (await json(await admin('/admin/api/forwards'))).body;
    assert.equal(list.subscriptions.length, 6);
    assert.equal(list.subscriptions.find(s => s.id === subs.issues).secret, 'forward-target-secret');
  });

  await t.test('an issue event reaches only issue subscriptions; failing targets never change the webhook reply', async () => {
    const delivery = github('issues', { action: 'opened', repository, issue: { number: 4, title: 'forward me' } });
    const started = Date.now();
    const response = await mf.dispatchFetch('http://localhost/webhook/github', delivery.init);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, delivery_id: delivery.delivery });
    assert.ok(Date.now() - started < 3000, 'the reply does not wait for the slow target');
    const [sent] = await until(() => to('/issues').length && to('/issues'));
    assert.equal(sent.body.toString(), delivery.body);
    assert.equal(sent.headers['x-sdbot-provider'], 'github');
    assert.equal(sent.headers['x-sdbot-event'], 'issue');
    assert.equal(sent.headers['x-sdbot-delivery'], delivery.delivery);
    assert.equal(sent.headers['x-hub-signature-256'], 'sha256=' + createHmac('sha256', 'forward-target-secret').update(delivery.body).digest('hex'));
    assert.equal(to('/other').length + to('/gitcode-push').length, 0);
    // Results are recorded per subscription: HTTP status, refused redirect, five-second timeout.
    const last = await until(async () => {
      const list = (await json(await admin('/admin/api/forwards'))).body.subscriptions;
      const by = Object.fromEntries(list.map(s => [s.id, s.last]));
      return [subs.issues, subs.broken, subs.redirect, subs.slow].every(id => by[id]) && by;
    });
    assert.deepEqual([last[subs.issues].status, last[subs.issues].error, last[subs.issues].delivery_id], [200, null, delivery.delivery]);
    assert.deepEqual([last[subs.broken].status, last[subs.broken].error], [500, 'HTTP 500']);
    assert.deepEqual([last[subs.redirect].status, last[subs.redirect].error], [302, 'redirect not followed (HTTP 302)']);
    assert.deepEqual([last[subs.slow].status, last[subs.slow].error], [null, 'timed out after 5 s']);
    assert.equal(to('/redirected').length, 0);
    assert.equal(last[subs.other], null);
  });

  await t.test('other types, GitCode and ping are filtered by source and type', async () => {
    const before = received.length;
    const run = github('workflow_run', { action: 'completed', repository, workflow_run: { id: 1 } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', run.init)).status, 200);
    await until(() => to('/other').length === 1);
    assert.equal(to('/other')[0].headers['x-sdbot-event'], 'workflow_run');
    const body = JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main', project: { path_with_namespace: 'openJiuwen/sciencediscovery' } });
    const push = await mf.dispatchFetch('http://localhost/webhook/gitcode', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-gitcode-event': 'Push Hook',
      'x-gitcode-delivery': 'gitcode-push-1', 'x-gitcode-signature-256': 'sha256=' + createHmac('sha256', GITCODE_SECRET).update(body).digest('hex') } });
    assert.equal(push.status, 200);
    const [gitcode] = await until(() => to('/gitcode-push').length && to('/gitcode-push'));
    assert.deepEqual([gitcode.headers['x-sdbot-provider'], gitcode.headers['x-sdbot-event'], gitcode.headers['x-hub-signature-256']], ['gitcode', 'push', undefined]);
    const ping = github('ping', { zen: 'hi', hook_id: 1, hook: { type: 'App' } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', ping.init)).status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(received.length - before, 2, 'ping matches no subscription; only the two events above were forwarded');
  });

  await t.test('rejected and repeated deliveries are not forwarded', async () => {
    const before = to('/issues').length;
    const forged = github('issues', { action: 'opened', repository, issue: { number: 5 } }, randomUUID(), 'wrong-secret');
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', forged.init)).status, 401);
    const once = github('issues', { action: 'edited', repository, issue: { number: 6 } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', once.init)).status, 200);
    await until(() => to('/issues').length === before + 1);
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', once.init)).status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(to('/issues').length, before + 1);
  });

  await t.test('secrets stay out of status and usage; updates and deletes apply at once', async () => {
    for (const path of ['/admin/api/status', '/admin/api/usage']) assert.doesNotMatch(await (await admin(path)).text(), /forward-target-secret/);
    const updated = await json(await admin('/admin/api/forwards/' + subs.issues, { method: 'PUT', body: { name: 'Issues', url: 'https://a.example/issues', providers: ['github'], types: ['pull_request'] } }));
    assert.deepEqual([updated.status, updated.body.subscription.types, updated.body.subscription.secret], [200, ['pull_request'], '']);
    assert.equal((await admin('/admin/api/forwards/' + subs.slow, { method: 'DELETE' })).status, 200);
    const list = (await json(await admin('/admin/api/forwards'))).body.subscriptions;
    assert.equal(list.length, 5);
    assert.equal((await admin('/admin/api/forwards/' + subs.slow, { method: 'DELETE' })).status, 404);
  });

  await t.test('the limit is 20 and management keeps its method and origin rules', async () => {
    const existing = (await json(await admin('/admin/api/forwards'))).body.subscriptions.length;
    for (let i = existing; i < 20; i++) assert.equal((await create({ name: 'Fill ' + i, url: 'https://a.example/fill' })).status, 201);
    const over = await create({ name: 'Too many', url: 'https://a.example/fill' });
    assert.deepEqual([over.status, over.body.error], [422, 'at most 20 subscriptions']);
    assert.equal((await admin('/admin/api/forwards', { method: 'PATCH', body: {} })).status, 405);
    assert.equal((await admin('/admin/api/forwards/' + subs.issues, { method: 'POST', body: {} })).status, 405);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await admin('/admin/api/status', { method })).status, 405);
    assert.equal((await admin('/admin/api/forwards', { method: 'POST', body: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await admin('/admin/api/forwards', { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await mf.dispatchFetch('http://localhost/admin/api/forwards')).status, 401);
    assert.equal((await mf.dispatchFetch('http://localhost/admin/api/forwards', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
  });
});
