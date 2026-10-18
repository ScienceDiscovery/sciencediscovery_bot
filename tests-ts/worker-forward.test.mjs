import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { accessFixture } from './support/access.mjs';
import { deliver as forwardDelivery, matches, forwardAction, parseSubscription, publicSubscription, FORWARD_ACTIONS, signatureMode } from '../src/core/forward.ts';

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
      issues: { name: 'Issues', url: 'https://a.example/issues', secret: 'forward-target-secret', headers: [{ name: 'X-Note', value: 'configured' }, { name: 'Authorization', value: 'configured-auth' }, { name: 'X-Added', value: 'added' }] },
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
    // Deliberate whitespace and Unicode detect an accidental parse/stringify of the body.
    delivery.body = ' \n' + delivery.body.replace('forward me', '原样转发') + '\n';
    delivery.init.body = delivery.body;
    Object.assign(delivery.init.headers, {
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', GITHUB_SECRET).update(delivery.body).digest('hex'),
      'User-Agent': 'GitHub-Hookshot/fixture', 'content-type': 'application/json; charset=utf-8',
      'X-Note': 'source-note', 'AUTHORIZATION': 'source-auth', Host: 'inbound.example',
      'Content-Length': String(Buffer.byteLength(delivery.body)), Cookie: 'private-cookie=fixture',
      'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2', 'Forwarded': 'for=fixture', Via: 'fixture',
      'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'inbound.example', 'X-Forwarded-Port': '443',
      'X-Real-IP': '192.0.2.3', 'True-Client-IP': '192.0.2.4', 'CDN-Loop': 'fixture',
      'Proxy-Authorization': 'fixture', 'Sec-Fetch-Site': 'same-origin', 'X-Sdbot-Provider': 'forged', 'X-Sdbot-Signature-256': 'forged'
    });
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
    assert.equal(sent.headers['x-hub-signature-256'], delivery.init.headers['x-hub-signature-256']);
    const subscriptionSignature = 'sha256=' + createHmac('sha256', 'forward-target-secret').update(sent.body).digest('hex');
    assert.equal(sent.headers['x-sdbot-signature-256'], subscriptionSignature);
    assert.notEqual(sent.headers['x-hub-signature-256'], subscriptionSignature);
    assert.equal(sent.headers['x-sdbot-action'], 'opened');
    assert.deepEqual([sent.headers['user-agent'], sent.headers['content-type'], sent.headers['x-github-event'], sent.headers['x-github-delivery']],
      ['GitHub-Hookshot/fixture', 'application/json; charset=utf-8', 'issues', delivery.delivery]);
    assert.deepEqual([sent.headers['x-note'], sent.headers.authorization, sent.headers['x-added']], ['source-note', 'source-auth', 'added']);
    // workerd adds destination Host/framing itself. The direct send test below verifies
    // neither header is copied into RequestInit; source Host must never reach the target.
    assert.equal(sent.headers.host, 'a.example');
    if (sent.headers['content-length'] !== undefined) assert.equal(sent.headers['content-length'], String(Buffer.byteLength(delivery.body)));
    for (const name of ['cookie', 'cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'via', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'true-client-ip', 'cdn-loop', 'proxy-authorization', 'sec-fetch-site']) {
      assert.equal(sent.headers[name], undefined, name);
    }
    assert.equal(to('/other').length + to('/gitcode-push').length, 0);
    // Results are recorded per subscription: HTTP status, refused redirect, five-second timeout.
    const last = await until(async () => {
      const list = (await json(await admin('/admin/api/forwards'))).body.subscriptions;
      const by = Object.fromEntries(list.map(s => [s.id, s.last]));
      return [subs.issues, subs.broken, subs.redirect, subs.slow].every(id => by[id]) && by;
    });
    assert.deepEqual([last[subs.issues].status, last[subs.issues].error, last[subs.issues].delivery_id], [200, null, delivery.delivery]);
    assert.deepEqual([last[subs.issues].event, last[subs.issues].repo, last[subs.issues].test, typeof last[subs.issues].duration_ms], ['issue', 'openJiuwen-ai/sciencediscovery', undefined, 'number']);
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
    assert.equal(gitcode.body.toString(), body);
    assert.equal(gitcode.headers['x-gitcode-event'], 'Push Hook');
    assert.equal(gitcode.headers['x-gitcode-signature-256'], 'sha256=' + createHmac('sha256', GITCODE_SECRET).update(body).digest('hex'));
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
    assert.deepEqual([updated.status, updated.body.subscription.types, updated.body.subscription.secret], [200, ['pull_request'], 'forward-target-secret']);
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

test('subscriptions can be limited to repositories and send configured headers', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-forward-repos-'));
  const access = await accessFixture();
  const received = [];
  const mf = await workerRuntime({ directory, bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET, SDBOT_REPOS: 'openJiuwen-ai/sciencediscovery', SDBOT_ENVIRONMENT: 'test' },
    outboundService: async request => {
      const jwks = access.jwks(request); if (jwks) return jwks;
      received.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      return new Response('ok');
    } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const create = async fields => { const response = await access.admin(mf, '/admin/api/forwards', { method: 'POST', body: { providers: ['github'], types: ['issue'], ...fields } }); return { status: response.status, body: await response.json() }; };
  const to = path => received.filter(r => r.url === 'https://a.example' + path);
  const deliver = async repo => {
    const delivery = github('issues', { action: 'opened', repository: { full_name: repo }, issue: { number: 1 } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', delivery.init)).status, 200);
  };

  await t.test('repositories and headers are validated', async () => {
    for (const [fields, error] of [
      [{ repos: ['not-a-repo'] }, /repos must be owner\/name/],
      [{ repos: 'openJiuwen-ai/sciencediscovery' }, /repos must be a list/],
      [{ headers: [{ name: 'Bad Name', value: 'x' }] }, /not a valid field name/],
      [{ headers: [{ name: 'X-Note', value: 'one\r\nX-Injected: yes' }] }, /without line breaks/],
      [{ headers: [{ name: 'Content-Type', value: 'text/plain' }] }, /cannot be configured/],
      [{ headers: [{ name: 'X-Sdbot-Event', value: 'issue' }] }, /cannot be configured/],
      [{ headers: [{ name: 'X-Hub-Signature-256', value: 'sha256=0' }] }, /cannot be configured/],
      [{ headers: [{ name: 'Host', value: 'a.example' }] }, /cannot be configured/],
      ...['webhook-id', 'Webhook-Timestamp', 'WEBHOOK-SIGNATURE', 'User-Agent', 'Cookie', 'X-GitCode-Signature-256', 'CF-Test', 'Sec-Test', 'Proxy-Test', 'X-Sdbot-Signature-256'].map(name => [{ headers: [{ name, value: 'fixture' }] }, /cannot be configured/]),
      [{ headers: [{ name: 'Authorization', value: 'a' }, { name: 'authorization', value: 'b' }] }, /more than once/],
      [{ headers: Array.from({ length: 11 }, (_, i) => ({ name: 'X-H' + i, value: 'v' })) }, /at most 10 headers/],
    ]) {
      const result = await create({ name: 'invalid', url: 'https://a.example/x', ...fields });
      assert.equal(result.status, 422, JSON.stringify(fields).slice(0, 80));
      assert.match(result.body.error, error);
    }
  });

  await t.test('only listed repositories are forwarded, compared without case', async () => {
    assert.equal((await create({ name: 'Main repo', url: 'https://a.example/main', repos: ['OPENJIUWEN-AI/SCIENCEDISCOVERY'] })).status, 201);
    assert.equal((await create({ name: 'Other repo', url: 'https://a.example/other-repo', repos: ['someone/else'] })).status, 201);
    assert.equal((await create({ name: 'Any repo', url: 'https://a.example/any' })).status, 201);
    await deliver('openJiuwen-ai/sciencediscovery');
    await until(() => to('/main').length === 1 && to('/any').length === 1);
    // An out-of-scope repository is still archived (ignored) and still forwarded where it is listed.
    await deliver('someone/else');
    await until(() => to('/other-repo').length === 1 && to('/any').length === 2);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual([to('/main').length, to('/other-repo').length, to('/any').length], [1, 1, 2]);
  });

  await t.test('configured headers reach the target and stay admin-only', async () => {
    const created = await create({ name: 'With token', url: 'https://a.example/with-token', headers: [{ name: 'Authorization', value: 'Bearer crsr_test_value' }, { name: 'X-Env', value: 'prod' }] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.subscription.headers, [{ name: 'Authorization', value: 'Bearer crsr_test_value' }, { name: 'X-Env', value: 'prod' }]);
    await deliver('openJiuwen-ai/sciencediscovery');
    const [sent] = await until(() => to('/with-token').length && to('/with-token'));
    assert.deepEqual([sent.headers.authorization, sent.headers['x-env'], sent.headers['x-sdbot-provider'], sent.headers['content-type']], ['Bearer crsr_test_value', 'prod', 'github', 'application/json']);
    for (const path of ['/admin/api/status', '/admin/api/usage', '/admin/api/events']) assert.doesNotMatch(await (await access.admin(mf, path)).text(), /crsr_test_value/, path);
    const list = await (await access.admin(mf, '/admin/api/forwards')).json();
    assert.equal(list.subscriptions.find(s => s.name === 'With token').headers[0].value, 'Bearer crsr_test_value', 'readable for editing behind Access');
  });
});

test('a test send reaches the target at once and the latest 20 results are kept', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-forward-test-'));
  const access = await accessFixture();
  const received = [];
  const mf = await workerRuntime({ directory, bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET, SDBOT_REPOS: 'openJiuwen-ai/sciencediscovery', SDBOT_ENVIRONMENT: 'test' },
    outboundService: async request => {
      const jwks = access.jwks(request); if (jwks) return jwks;
      received.push({ url: request.url, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
      // A careless target that echoes the credentials it was sent, then a long tail.
      if (new URL(request.url).hostname === 'echo.example') {
        return new Response(`denied: Authorization ${request.headers.get('authorization')}, X-Env ${request.headers.get('x-env')}\n` + 'x'.repeat(5000), { status: 500 });
      }
      return new Response('{"ok":true}');
    } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = (path, options) => access.admin(mf, path, options);
  const json = async response => ({ status: response.status, body: await response.json() });
  const runTest = async id => json(await admin(`/admin/api/forwards/${id}/test`, { method: 'POST', body: {} }));
  const list = async () => (await json(await admin('/admin/api/forwards'))).body;
  const to = path => received.filter(r => r.url === 'https://a.example' + path);
  const credentials = [{ name: 'Authorization', value: 'Bearer crsr_test_value' }, { name: 'X-Env', value: 'custom-value-123' }];
  let tested;

  await t.test('the test request carries the subscription headers and signature, but not its filters', async () => {
    // Filters that no delivery here would pass: a test is sent regardless of source, type and repository.
    const created = await json(await admin('/admin/api/forwards', { method: 'POST', body: { name: 'Tested', url: 'https://a.example/tested', providers: ['gitcode'], types: ['pull_request'],
      repos: ['someone/else'], actions: ['pull_request:closed'], secret: 'forward-target-secret', headers: credentials } }));
    tested = created.body.subscription.id;
    assert.deepEqual(created.body.subscription.recent, []);
    const reply = await runTest(tested);
    assert.equal(reply.status, 200);
    const { result } = reply.body;
    assert.deepEqual([result.status, result.error, result.test, result.event, result.repo, typeof result.duration_ms], [200, null, true, 'ping', '', 'number']);
    assert.match(result.delivery_id, /^test-[0-9a-f-]{36}$/);
    assert.equal(reply.body.response_excerpt, '{"ok":true}');
    const [sent] = to('/tested');
    assert.equal(to('/tested').length, 1, 'sent before the reply');
    assert.deepEqual([sent.headers['x-sdbot-test'], sent.headers['x-sdbot-provider'], sent.headers['x-sdbot-event'], sent.headers['x-sdbot-delivery']], ['1', 'test', 'ping', result.delivery_id]);
    assert.deepEqual([sent.headers.authorization, sent.headers['x-env'], sent.headers['content-type']], ['Bearer crsr_test_value', 'custom-value-123', 'application/json']);
    assert.equal(sent.headers['x-hub-signature-256'], 'sha256=' + '0'.repeat(64));
    assert.equal(sent.headers['x-sdbot-signature-256'], 'sha256=' + createHmac('sha256', 'forward-target-secret').update(sent.body).digest('hex'));
    assert.equal(sent.headers['user-agent'], 'GitHub-Hookshot/test');
    assert.equal(sent.headers['x-sdbot-action'], '');
    const body = JSON.parse(sent.body.toString());
    assert.deepEqual([body.test, body.subscription], [true, { id: tested, name: 'Tested' }]);
    const sub = (await list()).subscriptions.find(s => s.id === tested);
    assert.deepEqual([sub.last, sub.recent], [result, [result]]);
  });

  await t.test('a failing target shows its status and a scrubbed, shortened excerpt', async () => {
    const created = await json(await admin('/admin/api/forwards', { method: 'POST', body: { name: 'Echo', url: 'https://echo.example/hook', providers: ['github'], types: ['issue'], headers: credentials } }));
    const reply = await runTest(created.body.subscription.id);
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.body.result.status, reply.body.result.error], [500, 'HTTP 500']);
    const excerpt = reply.body.response_excerpt;
    assert.match(excerpt, /^denied: Authorization \[REDACTED\], X-Env \[REDACTED\]\nx+$/);
    assert.ok(excerpt.length <= 500);
    assert.doesNotMatch(excerpt, /crsr_test_value|custom-value-123/);
    // Test sends are not webhooks: nothing is archived and the excerpt is not stored.
    const stored = await (await admin('/admin/api/forwards')).text();
    assert.doesNotMatch(stored, /denied/);
    assert.doesNotMatch(await (await admin('/admin/api/events')).text(), new RegExp(reply.body.result.delivery_id));
  });

  await t.test('history keeps the newest 20 results, deliveries and tests together, across edits', async () => {
    const updated = await json(await admin('/admin/api/forwards/' + tested, { method: 'PUT', body: { name: 'Tested', url: 'https://a.example/tested', providers: ['github'], types: ['issue'],
      secret: 'forward-target-secret', headers: credentials } }));
    assert.equal(updated.body.subscription.recent.length, 1, 'editing keeps the results');
    const delivery = github('issues', { action: 'opened', repository, issue: { number: 7 } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', delivery.init)).status, 200);
    const recent = await until(async () => { const sub = (await list()).subscriptions.find(s => s.id === tested); return sub.recent.length === 2 && sub.recent; });
    assert.deepEqual([recent[0].delivery_id, recent[0].event, recent[0].repo, recent[0].test, recent[1].test], [delivery.delivery, 'issue', 'openJiuwen-ai/sciencediscovery', undefined, true]);
    const ids = [];
    for (let i = 0; i < 18; i++) ids.unshift((await runTest(tested)).body.result.delivery_id);
    let doc = await list(), sub = doc.subscriptions.find(s => s.id === tested);
    assert.equal(doc.history, 20);
    assert.deepEqual(sub.recent.slice(0, 18).map(r => r.delivery_id), ids, 'newest first');
    assert.deepEqual(sub.recent.slice(18).map(r => r.event), ['issue', 'ping']);
    for (let i = 0; i < 2; i++) ids.unshift((await runTest(tested)).body.result.delivery_id);
    sub = (await list()).subscriptions.find(s => s.id === tested);
    assert.deepEqual(sub.recent.map(r => r.delivery_id), ids, 'the oldest two dropped');
    assert.deepEqual(sub.last, sub.recent[0]);
  });

  await t.test('the test action is a same-origin JSON POST behind Access', async () => {
    const before = received.length, path = `/admin/api/forwards/${tested}/test`;
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await admin(path, { method, ...(method === 'PUT' ? { body: {} } : {}) });
      assert.deepEqual([response.status, response.headers.get('allow')], [405, 'POST'], method);
    }
    assert.equal((await runTest(randomUUID())).status, 404);
    assert.equal((await admin(path, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await admin(path, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await admin(`/admin/api/callers/${randomUUID()}/test`, { method: 'POST', body: {} })).status, 405);
    assert.equal((await mf.dispatchFetch('http://localhost' + path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal(received.length, before, 'no refused request reached a target');
  });
});

test('forward actions classify archived fields and preserve legacy subscriptions', () => {
  const legacy = { providers: ['github', 'gitcode'], types: ['issue', 'pull_request', 'issue_comment', 'pull_request_review', 'push', 'ping', 'other'], repos: [] };
  const record = { provider: 'github', kind: 'issue', action: 'closed', repo: 'owner/repo', extra: {} };
  assert.equal(matches(legacy, record), true, 'an old subscription without actions keeps all actions');
  assert.deepEqual(publicSubscription(legacy).actions, []);
  assert.equal('actions' in legacy, false, 'reading an old subscription does not mutate it');
  assert.equal(matches({ ...legacy, actions: [] }, record), true);
  assert.equal(matches({ ...legacy, actions: ['issue:opened'] }, record), false);
  assert.equal(matches({ ...legacy, actions: ['issue:opened'] }, { ...record, kind: 'pull_request' }), true, 'a type without selected actions is unrestricted');
  assert.equal(matches({ ...legacy, types: ['issue'], actions: ['issue:opened'] }, { ...record, kind: 'pull_request', action: 'opened' }), false);
  assert.equal(matches({ ...legacy, providers: ['gitcode'] }, record), false);
  assert.equal(matches({ ...legacy, repos: ['someone/else'] }, record), false);
  for (const [kind, actions] of Object.entries(FORWARD_ACTIONS)) {
    for (const action of actions) {
      const extra = kind === 'issue_comment' ? { on: action } : action === 'diff_comment' ? { on: 'diff_comment' } : {};
      const entry = { ...record, kind, action: action === 'other' ? 'unrecognized' : action, extra };
      if (kind === 'issue_comment') entry.action = 'created';
      assert.equal(forwardAction(entry), `${kind}:${action}`);
      assert.equal(matches({ ...legacy, actions: [`${kind}:${action}`] }, entry), true);
      const different = actions.find(candidate => candidate !== action);
      assert.equal(matches({ ...legacy, actions: [`${kind}:${different}`] }, entry), false);
    }
  }
  assert.equal(matches({ ...legacy, actions: ['pull_request:closed'] }, { ...record, kind: 'pull_request', action: 'merged' }), false);
  assert.equal(matches({ ...legacy, actions: ['issue:opened'] }, { ...record, kind: 'push' }), true);
  assert.equal(matches({ ...legacy, actions: ['issue:opened'] }, { ...record, kind: 'ping' }), true);
  assert.equal(matches({ ...legacy, actions: ['issue:opened'] }, { ...record, kind: 'workflow_run' }), true);
  for (const value of [null, 'issue:opened', ['issue:unknown'], ['pull_request:opened'], ['push:pushed'], ['other:other'], [4]]) {
    const parsed = parseSubscription({ name: 'Actions', url: 'https://a.example/hook', providers: ['github'], types: ['issue'], actions: value });
    assert.equal(parsed.ok, false, JSON.stringify(value));
  }
});

test('forwarding drops infrastructure headers and only supplies missing header values', async () => {
  const omitted = ['content-length', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'content-encoding', 'cookie',
    'proxy-authorization', 'cf-connecting-ip', 'sec-fetch-site', 'x-sdbot-provider', 'x-sdbot-action', 'x-sdbot-signature-256',
    'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'true-client-ip', 'cdn-loop'];
  const source = new Headers(omitted.map(name => [name, 'fixture']));
  source.set('User-Agent', 'source-agent'); source.set('Content-Type', 'application/custom+json');
  source.set('X-Hub-Signature-256', 'source-platform-signature'); source.set('X-GitCode-Signature-256', 'gitcode-platform-signature');
  source.set('X-Mixed-Case', 'original');
  const sub = { id: 'fixture', name: 'Fixture', url: 'https://a.example/unit', secret: 'subscription-secret', headers: [
    { name: 'x-MIXED-case', value: 'replacement' }, { name: 'X-New', value: 'additional' },
    { name: 'X-Hub-Signature-256', value: 'forged' }, { name: 'X-GitCode-Signature-256', value: 'forged' }
  ] };
  const record = { provider: 'gitcode', kind: 'pull_request', action: 'merged', record_id: 'archive-id' };
  const body = new TextEncoder().encode('  {"text":"中文"}\n');
  let sent;
  const fetcher = async (_url, init) => { sent = init; return new Response('ok'); };
  await forwardDelivery(sub, record, body, source, fetcher);
  assert.deepEqual(sent.body, body);
  assert.equal(sent.headers.get('user-agent'), 'source-agent');
  assert.equal(sent.headers.get('content-type'), 'application/custom+json');
  assert.equal(sent.headers.get('x-hub-signature-256'), 'source-platform-signature');
  assert.equal(sent.headers.get('x-gitcode-signature-256'), 'gitcode-platform-signature');
  assert.equal(sent.headers.get('x-mixed-case'), 'original');
  assert.equal(sent.headers.get('x-new'), 'additional');
  assert.equal(sent.headers.get('x-sdbot-provider'), 'gitcode');
  assert.equal(sent.headers.get('x-sdbot-event'), 'pull_request');
  assert.equal(sent.headers.get('x-sdbot-action'), 'merged');
  assert.equal(sent.headers.get('x-sdbot-delivery'), 'archive-id');
  for (const name of omitted.filter(name => !name.startsWith('x-sdbot-'))) assert.equal(sent.headers.has(name), false, name);
  const signature = 'sha256=' + createHmac('sha256', sub.secret).update(body).digest('hex');
  assert.equal(sent.headers.get('x-sdbot-signature-256'), signature);
  assert.equal(source.get('x-sdbot-provider'), 'fixture', 'the source headers are not mutated');
  await forwardDelivery(sub, record, body, new Headers(), fetcher);
  assert.equal(sent.headers.get('user-agent'), 'sciencediscovery-bot-forward');
  assert.equal(sent.headers.get('content-type'), 'application/json');
  assert.equal(sent.headers.get('x-hub-signature-256'), null, 'preserve never invents a platform signature');
  const emptySignature = new Headers({ 'X-Hub-Signature-256': '' });
  await forwardDelivery(sub, record, body, emptySignature, fetcher);
  assert.equal(sent.headers.get('x-hub-signature-256'), '', 'an existing empty value is not replaced');
});

test('action filters use the archived GitHub and GitCode actions after type matching', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-forward-actions-'));
  const access = await accessFixture(), received = [];
  const mf = await workerRuntime({ directory, bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET, SDBOT_GITCODE_WEBHOOK_SECRET: GITCODE_SECRET,
    SDBOT_REPOS: 'openJiuwen-ai/sciencediscovery', SDBOT_ENVIRONMENT: 'test' }, outboundService: async request => {
    const jwks = access.jwks(request); if (jwks) return jwks;
    received.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: await request.text() });
    return new Response('ok');
  } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const create = async (name, types, actions, extra = {}) => access.admin(mf, '/admin/api/forwards', { method: 'POST', body: {
    name, url: 'https://a.example/' + name, providers: ['github', 'gitcode'], types, ...(actions === undefined ? {} : { actions }), ...extra } });
  assert.equal((await create('invalid', ['issue'], ['pull_request:opened'])).status, 422);
  assert.equal((await create('invalid', ['push'], ['push:pushed'])).status, 422);
  const specs = [
    ['opened', ['issue', 'pull_request'], ['issue:opened']],
    ['closed-pr', ['pull_request'], ['pull_request:closed']],
    ['merged-pr', ['pull_request'], ['pull_request:merged']],
    ['pr-comments', ['issue_comment'], ['issue_comment:pull_request']],
    ['diff-comments', ['pull_request_review'], ['pull_request_review:diff_comment']],
    ['all', ['issue', 'pull_request', 'issue_comment', 'pull_request_review', 'push', 'ping', 'other'], undefined],
    ['gitcode-signed', ['push'], [], { providers: ['gitcode'], secret: 'gitcode-forward-secret' }]
  ];
  for (const spec of specs) assert.equal((await create(...spec)).status, 201);
  const cases = [
    ['issues', { action: 'opened', repository, issue: { number: 1 } }, ['opened', 'all']],
    ['issues', { action: 'closed', repository, issue: { number: 1 } }, ['all']],
    ['pull_request', { action: 'opened', repository, pull_request: { number: 2 } }, ['opened', 'all']],
    ['pull_request', { action: 'closed', repository, pull_request: { number: 2, merged: false } }, ['opened', 'closed-pr', 'all']],
    ['pull_request', { action: 'closed', repository, pull_request: { number: 2, merged: true } }, ['opened', 'merged-pr', 'all']],
    ['issue_comment', { action: 'created', repository, issue: { number: 1 }, comment: {} }, ['all']],
    ['pull_request_review', { action: 'submitted', repository, pull_request: { number: 2 }, review: {} }, ['all']],
    ['pull_request_review_comment', { action: 'created', repository, pull_request: { number: 2 }, comment: {} }, ['diff-comments', 'all']],
    ['Note Hook', { object_kind: 'note', project: { path_with_namespace: 'openJiuwen/sciencediscovery' }, object_attributes: { noteable_type: 'MergeRequest' }, merge_request: { iid: 3 } }, ['pr-comments', 'all']],
    ['Push Hook', { object_kind: 'push', ref: 'refs/heads/main', project: { path_with_namespace: 'openJiuwen/sciencediscovery' } }, ['gitcode-signed', 'all']]
  ];
  for (const [event, payload, expected] of cases) {
    const fromGitCode = event.endsWith('Hook'), source = fromGitCode ? 'gitcode' : 'github';
    const delivery = github(event, payload);
    if (fromGitCode) delivery.init.headers = { 'content-type': 'application/json', 'x-gitcode-event': event, 'x-gitcode-delivery': delivery.delivery,
      'x-gitcode-signature-256': 'sha256=' + createHmac('sha256', GITCODE_SECRET).update(delivery.body).digest('hex') };
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/' + source, delivery.init)).status, 200);
    await until(() => received.filter(row => row.headers['x-sdbot-delivery'] === delivery.delivery).length >= expected.length);
    const sent = received.filter(row => row.headers['x-sdbot-delivery'] === delivery.delivery);
    assert.deepEqual(sent.map(row => row.path.slice(1)).sort(), expected.slice().sort(), event + ' ' + (payload.action || ''));
    for (const row of sent) assert.equal(row.body, delivery.body);
    if (event === 'Push Hook') {
      const signed = sent.find(row => row.path === '/gitcode-signed');
      assert.equal(signed.headers['x-gitcode-event'], 'Push Hook');
      assert.equal(signed.headers['x-gitcode-signature-256'], delivery.init.headers['x-gitcode-signature-256']);
      const signature = 'sha256=' + createHmac('sha256', 'gitcode-forward-secret').update(signed.body).digest('hex');
      assert.equal(signed.headers['x-sdbot-signature-256'], signature);
      assert.equal(signed.headers['x-hub-signature-256'], undefined);
    }
  }
});

test('signature modes migrate by creation time without rewriting legacy subscriptions', () => {
  assert.equal(signatureMode({ created: '2026-10-18T09:02:43.999Z' }), 'github-compatible');
  assert.equal(signatureMode({ created: '2026-10-18T09:02:44Z' }), 'preserve');
  assert.equal(signatureMode({ created: '2026-10-19T00:00:00Z' }), 'preserve');
  assert.equal(signatureMode({ created: '2026-10-01', signature_mode: 'preserve' }), 'preserve');
  assert.equal(parseSubscription({ name: 'x', url: 'https://a.example', providers: ['github'], types: ['issue'], signature_mode: 'unknown' }).ok, false);
  assert.equal(parseSubscription({ name: 'x', url: 'https://a.example', providers: ['github'], types: ['issue'], secret: 'whsec_invalid!' }).ok, false);
});

test('official Standard Webhooks verification covers real GitHub, GitCode and representative tests in both modes', { timeout: 60000 }, async t => {
  const { Webhook } = await import('standardwebhooks');
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/standard-forward-')), access = await accessFixture(), received = [];
  const mf = await workerRuntime({ directory, bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET, SDBOT_GITCODE_WEBHOOK_SECRET: GITCODE_SECRET },
    outboundService: async request => {
      const jwks = access.jwks(request); if (jwks) return jwks;
      received.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
      return new Response('ok', { status: 202 });
    } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const subs = [];
  for (const secret of ['legacy-密钥', 'whsec_' + Buffer.alloc(32, 7).toString('base64')]) for (const mode of ['preserve', 'github-compatible']) {
    const sub = (await (await access.admin(mf, '/admin/api/forwards', { method: 'POST', body: { name: mode, url: 'https://standard.example/' + subs.length,
      providers: ['github', 'gitcode'], types: ['issue', 'push'], secret, signature_mode: mode } })).json()).subscription;
    subs.push(sub);
  }
  const gh = github('issues', { action: 'opened', repository, issue: { number: 100, title: '标准签名' } });
  gh.init.headers['webhook-id'] = 'forged-id'; gh.init.headers['webhook-timestamp'] = '1'; gh.init.headers['webhook-signature'] = 'v1,forged';
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', gh.init)).status, 200);
  await until(() => received.length === 4);
  const gcBody = JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main', project: { path_with_namespace: 'other/project' } });
  const gcSignature = 'sha256=' + createHmac('sha256', GITCODE_SECRET).update(gcBody).digest('hex');
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/gitcode', { method: 'POST', body: gcBody, headers: {
    'content-type': 'application/json', 'x-gitcode-event': 'Push Hook', 'x-gitcode-delivery': 'standard-gc', 'x-gitcode-signature-256': gcSignature } })).status, 200);
  await until(() => received.length === 8);
  for (const sub of subs) assert.equal((await access.admin(mf, `/admin/api/forwards/${sub.id}/test`, { method: 'POST', body: {} })).status, 200);
  assert.equal(received.length, 12);
  for (const sent of received) {
    const sub = subs[Number(sent.path.slice(1))], h = sent.headers, sample = h['x-sdbot-test'] === '1', githubSource = h['x-sdbot-provider'] === 'github';
    const verifier = sub.secret.startsWith('whsec_') ? new Webhook(sub.secret) : new Webhook(new TextEncoder().encode(sub.secret), { format: 'raw' });
    assert.doesNotThrow(() => verifier.verify(sent.body, h));
    assert.equal(h['webhook-id'], h['x-sdbot-delivery']); assert.notEqual(h['webhook-id'], 'forged-id');
    assert.notEqual(h['webhook-timestamp'], '1'); assert.match(h['webhook-signature'], /^v1,[A-Za-z0-9+/]+=*$/);
    const relay = 'sha256=' + createHmac('sha256', sub.secret).update(sent.body).digest('hex');
    assert.equal(h['x-sdbot-signature-256'], relay);
    const upstream = sample ? 'sha256=' + '0'.repeat(64) : githubSource ? gh.init.headers['x-hub-signature-256'] : gcSignature;
    const upstreamHeader = sample || githubSource ? 'x-hub-signature-256' : 'x-gitcode-signature-256';
    if (sub.signature_mode === 'github-compatible') {
      assert.equal(h['x-hub-signature-256'], relay); assert.equal(h['x-gitcode-signature-256'], relay);
      assert.equal(h[sample || githubSource ? 'x-sdbot-source-signature-256' : 'x-sdbot-source-gitcode-signature-256'], upstream);
    } else {
      assert.equal(h[upstreamHeader], upstream);
      assert.equal(h[sample || githubSource ? 'x-gitcode-signature-256' : 'x-hub-signature-256'], undefined);
    }
    if (sample) assert.deepEqual([h['user-agent'], h['x-github-event'], h['x-github-delivery']], ['GitHub-Hookshot/test', 'ping', h['webhook-id']]);
    else assert.equal(sent.body.toString(), githubSource ? gh.body : gcBody);
  }
  for (const header of ['webhook-id','Webhook-Timestamp','WEBHOOK-SIGNATURE']) assert.equal(parseSubscription({ name: 'Bad', url: 'https://a.example', providers: ['github'], types: ['issue'], headers: [{ name: header, value: 'forged' }] }).ok, false);
});

test('retry policy is bounded and does not retry permanent authentication failures', async () => {
  const { retryableForward, forwardRetryDelay } = await import('../src/worker/forward.ts');
  for (const status of [408,429,500,503,599]) assert.equal(retryableForward({ status }), true, String(status));
  for (const status of [200,202,301,400,401,403,404,422,600]) assert.equal(retryableForward({ status }), false, String(status));
  for (const error of ['network error','timed out after 5 s']) assert.equal(retryableForward({ status: null, error }), true);
  assert.equal(retryableForward({ status: null, error: 'target rejected: private address' }), false);
  assert.deepEqual([1,2,3,9,100].map(forwardRetryDelay), [30000,60000,120000,3600000,3600000]);
});

test('durable retries survive restart, retain identity, respect the shared alarm and never retry 401', { timeout: 60000 }, async t => {
  const { Webhook } = await import('standardwebhooks');
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/forward-retries-')), access = await accessFixture(), received = [];
  let mf, releaseSlow;
  const outboundService = async request => {
    const jwks = access.jwks(request); if (jwks) return jwks;
    const path = new URL(request.url).pathname;
    received.push({ path, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
    const count = received.filter(row => row.path === path).length;
    if (path === '/auth') return new Response('no', { status: 401 });
    if (['/flaky','/slow','/missing','/expired','/sample'].includes(path) && count === 1) return new Response('busy', { status: 503 });
    if (path === '/slow' && count === 2) await new Promise(resolve => { releaseSlow = resolve; });
    return new Response('ok', { status: 202 });
  };
  const start = () => workerRuntime({ directory, entry: 'tests-ts/support/worker-forward-control.mjs', bindings: {
    ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET, SDBOT_REPOS: repository.full_name,
    SDBOT_GITHUB_APP_ID: '1', SDBOT_GITHUB_APP_PRIVATE_KEY: 'isolated-placeholder',
    SDBOT_BOARD_TARGETS: JSON.stringify({ [repository.full_name]: 'example/board' }), SDBOT_BOARD_DEBOUNCE: '600',
  }, outboundService });
  mf = await start();
  t.after(async () => { releaseSlow?.(); await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const control = async (path, init) => {
    const response = await mf.dispatchFetch('http://localhost/_test/' + path, init);
    assert.equal(response.status, 200, path); return response.json();
  };
  const admin = (path, options) => access.admin(mf, path, options);
  const subs = async () => (await (await admin('/admin/api/forwards')).json()).subscriptions;
  const jobs = () => control('forward-jobs');
  const to = path => received.filter(row => row.path === path);
  const create = async path => (await (await admin('/admin/api/forwards', { method: 'POST', body: {
    name: path, url: 'https://retry.example' + path, providers: ['github'], types: ['issue'], secret: 'retry-secret', signature_mode: 'github-compatible'
  } })).json()).subscription;
  const send = async (title = 'Retry', event = 'issues') => {
    const delivery = github(event, { action: 'opened', repository, issue: { number: 1, title } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', delivery.init)).status, 200);
    return delivery;
  };
  const flaky = await create('/flaky'), first = await send();
  await until(async () => (await subs()).find(sub => sub.id === flaky.id).last?.retry_at);
  const pending = await jobs(); assert.equal(pending.length, 1);
  const initialAlarm = await control('alarm'); assert.ok(initialAlarm <= pending[0].due);
  const earlier = Date.now() + 29000;
  await control('alarm?at=' + earlier);
  await send('Unrelated', 'push');
  assert.equal(await control('alarm'), earlier, 'ingestion cannot push another queue\'s earlier alarm later');
  // Recreate the actual SQLite/R2-backed object before invoking its alarm handler.
  await mf.dispose(); mf = await start();
  assert.equal((await jobs()).length, 1, 'the retry survives a runtime restart');
  await control('forward-tick?ms=31000');
  assert.equal(to('/flaky').length, 2);
  const [before, after] = to('/flaky');
  assert.equal(after.headers['webhook-id'], before.headers['webhook-id']);
  assert.equal(after.headers['webhook-id'], first.delivery);
  assert.ok(Number(after.headers['webhook-timestamp']) > Number(before.headers['webhook-timestamp']));
  assert.notEqual(after.headers['webhook-signature'], before.headers['webhook-signature']);
  assert.equal(after.headers['x-sdbot-signature-256'], before.headers['x-sdbot-signature-256']);
  assert.equal(after.headers['x-hub-signature-256'], before.headers['x-hub-signature-256']);
  assert.equal(after.headers['x-sdbot-source-signature-256'], first.init.headers['x-hub-signature-256']);
  assert.deepEqual(after.body, before.body);
  for (const sent of [before, after]) assert.doesNotThrow(() => new Webhook('retry-secret', { format: 'raw' }).verify(sent.body, sent.headers));
  assert.equal((await jobs()).length, 0);
  let history = (await subs()).find(sub => sub.id === flaky.id).recent;
  assert.deepEqual(history.slice(0, 2).map(row => [row.status,row.attempt]), [[202,2],[503,1]]);

  const auth = await create('/auth'); await send('Permanent failure');
  await until(async () => (await subs()).find(sub => sub.id === auth.id).last?.status === 401);
  assert.equal((await jobs()).some(job => job.subscription === auth.id), false);
  await control('forward-tick?ms=31000'); assert.equal(to('/auth').length, 1);

  const slow = await create('/slow'); await send('Concurrent ingestion');
  await until(async () => (await jobs()).some(job => job.subscription === slow.id));
  const running = control('forward-tick?ms=31000');
  await until(() => releaseSlow);
  const next = send('Not blocked by outbound retry', 'push');
  await Promise.race([next, new Promise((_, reject) => setTimeout(() => reject(new Error('retry held the ingestion mutex')), 3000))]);
  releaseSlow(); await running;
  assert.equal(to('/slow').length, 2);

  const missing = await create('/missing'), lost = await send('Missing body');
  await until(async () => (await jobs()).some(job => job.subscription === missing.id));
  const archived = (await (await admin('/admin/api/events?delivery_id=' + lost.delivery)).json()).events[0];
  await control('drop-body?id=' + archived.record_id);
  await control('forward-tick?ms=31000');
  assert.equal(to('/missing').length, 1, 'missing archived bytes are never sent');
  assert.equal((await subs()).find(sub => sub.id === missing.id).last.error, 'archive body unavailable');
  assert.equal((await jobs()).some(job => job.subscription === missing.id), false);

  const expired = await create('/expired'); await send('Expired retry');
  await until(async () => (await jobs()).some(job => job.subscription === expired.id));
  await control('expire'); await control('forward-tick?ms=31000');
  assert.equal(to('/expired').length, 1);
  assert.equal((await subs()).find(sub => sub.id === expired.id).last.error, 'retry window expired');

  const sample = await create('/sample');
  assert.equal((await admin(`/admin/api/forwards/${sample.id}/test`, { method:'POST', body:{} })).status, 200);
  await control('forward-tick?ms=31000');
  assert.equal(to('/sample').length, 2);
  assert.deepEqual(to('/sample')[0].body, to('/sample')[1].body, 'test retries reconstruct the same sample without another archived body');
  assert.equal(to('/sample')[0].headers['webhook-id'], to('/sample')[1].headers['webhook-id']);
  assert.match(to('/sample')[1].headers['x-sdbot-test'], /1/);
});

test('archive redelivery is authenticated, distinct from ingestion and uses a new relay identity', { timeout: 30000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/forward-manual-')), access = await accessFixture(), received = [];
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-forward-control.mjs',
    bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET },
    outboundService: async request => {
      const jwks = access.jwks(request); if (jwks) return jwks;
      received.push({ headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
      return new Response('ok');
    } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = (path, options) => access.admin(mf, path, options);
  const sub = (await (await admin('/admin/api/forwards', { method: 'POST', body: {
    name: 'Manual', url: 'https://manual.example/hook', providers: ['github'], types: ['issue'], secret: 'manual-secret',
  } })).json()).subscription;
  const delivery = github('issues', { action: 'opened', repository, issue: { number: 2, title: 'From archive' } });
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', delivery.init)).status, 200);
  await until(() => received.length === 1);
  const original = (await (await admin('/admin/api/events?delivery_id=' + delivery.delivery)).json()).events[0];
  const path = `/admin/api/events/${original.record_id}/forward`;
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', delivery.init)).status, 200);
  assert.equal((await mf.dispatchFetch('http://localhost' + path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
  for (const method of ['GET', 'PUT', 'DELETE'])
    assert.equal((await admin(path, { method, ...(method === 'PUT' ? { body: {} } : {}) })).status, 405);
  assert.equal((await admin(path, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await admin(path, { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await admin(path, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
  const response = await admin(path, { method: 'POST', body: {} });
  assert.equal(response.status, 202);
  const sent = await response.json();
  assert.match(sent.webhook_id, new RegExp('^manual-' + original.record_id + '-[a-f0-9]{8}$'));
  await until(() => received.length === 2);
  assert.equal(received[1].headers['webhook-id'], sent.webhook_id);
  assert.notEqual(sent.webhook_id, delivery.delivery);
  assert.equal(received[1].body.toString(), delivery.body);
  assert.equal(received[1].headers['x-hub-signature-256'], undefined, 'redacted historic source credentials are not invented');
  const count = (await (await admin('/admin/api/events')).json()).count;
  assert.equal(count, 2, 'manual forwarding does not create another ingestion record or rerun business listeners');
  await admin('/admin/api/forwards/' + sub.id, { method: 'PUT', body: { ...sub, types: ['push'] } });
  assert.equal((await admin(path, { method: 'POST', body: {} })).status, 422);
  await mf.dispatchFetch('http://localhost/_test/drop-body?id=' + original.record_id);
  assert.equal((await admin(path, { method: 'POST', body: {} })).status, 404);
});

test('successful forwarding adds no new SQLite SELECTs and legacy mode reads do not rewrite subscriptions', { timeout: 30000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/forward-cost-')), access = await accessFixture();
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-forward-control.mjs',
    bindings: { ...access.bindings, SDBOT_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET },
    outboundService: request => access.jwks(request) || new Response('ok') });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = (path, options) => access.admin(mf, path, options);
  const rows = async () => (await mf.dispatchFetch('http://localhost/_test/rows')).json();
  const sub = (await (await admin('/admin/api/forwards', { method: 'POST', body: {
    name: 'Cost', url: 'https://cost.example', providers: ['github'], types: ['push'], secret: 'cost-secret',
  } })).json()).subscription;
  const send = async () => {
    const delivery = github('issues', { action: 'opened', repository, issue: { number: 1 } });
    assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', delivery.init)).status, 200);
  };
  await send(); await rows(); await send(); const baseline = await rows();
  await admin('/admin/api/forwards/' + sub.id, { method: 'PUT', body: { ...sub, types: ['issue'] } });
  await rows(); await send();
  await until(async () => (await (await admin('/admin/api/forwards')).json()).subscriptions.find(s => s.id === sub.id).last);
  const forwarded = await rows();
  assert.equal(forwarded.select_read, baseline.select_read, 'no new SELECT or retry-queue read on the success path');
  assert.equal(forwarded.read, baseline.read + 1, 'the existing result UPSERT reads its one subscription row');
  assert.equal(forwarded.written, baseline.written + 1, 'only the existing result row is updated');
  const legacy = { ...sub, id: randomUUID(), name: 'Legacy', created: '2026-10-18T09:02:43Z' };
  delete legacy.signature_mode;
  await mf.dispatchFetch('http://localhost/_test/seed', { method: 'POST', body: JSON.stringify(legacy) }); await rows();
  const listed = (await (await admin('/admin/api/forwards')).json()).subscriptions;
  assert.equal(listed.find(s => s.id === legacy.id).signature_mode, 'github-compatible');
  assert.equal((await rows()).written, 0, 'legacy signature modes are inferred without a migration write');
  const generated = (await (await admin('/admin/api/forwards', { method: 'POST', body: {
    name: 'Generated', url: 'https://cost.example/new', providers: ['github'], types: ['issue'],
  } })).json()).subscription;
  assert.match(generated.secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(generated.secret.slice(6), 'base64').length, 32);
});
