import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { GIT_FIXTURE, gitWorld } from './support/git-world.js';

// The production Worker bundle in workerd: webhook → Durable Object outbox → alarm →
// real git smart-HTTP transfer → GitCode REST / GitHub Checks fakes → OIDC-guarded records.
const secret = 'isolated-worker-sync-secret', issuer = 'https://token.actions.githubusercontent.com';
const SOURCE = 'openJiuwen-ai/sciencediscovery', TARGET = 'openJiuwen/sciencediscovery', BOARD = 'ScienceDiscovery/github-status-board';
const fixture = async name => JSON.parse(await readFile(resolve('tests-ts/fixtures/gitcode-sync', name), 'utf8')).payload;
const signed = (payload, delivery = randomUUID()) => {
  const body = JSON.stringify(payload);
  return { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } };
};
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  assert.fail('observable condition did not become true');
}

test('Worker: PR events sync through the durable queue with the original SHA; a GitCode note reads the verdict; records are OIDC-guarded and secret-free', { timeout: 90000 }, async t => {
  const w = await gitWorld(t);
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-sync-'));
  const oidc = await generateKeyPair('RS256'), app = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(oidc.publicKey), kid: 'actions-key', alg: 'RS256', use: 'sig' };
  const pulls = new Map(), checks = new Map(), notes = new Map(), outbound = [];
  let webhookPhase = false;
  const json = (value, status = 200) => Response.json(value, { status });
  const pullDoc = p => ({ ...p, html_url: `https://gitcode.test/${TARGET}/merge_requests/${p.number}`, head: { ref: p.head_ref, sha: w.git(w.gitcode, 'rev-parse', 'refs/heads/' + p.head_ref), repo: { full_name: TARGET } }, base: { ref: 'main' }, labels: p.labels.map(name => ({ name })) });
  const outboundService = async request => {
    const url = new URL(request.url);
    outbound.push(`${request.method} ${url.origin}${url.pathname}`);
    assert.equal(webhookPhase, false, 'no outbound request may happen while a webhook is being answered');
    assert.ok(!request.url.includes(GIT_FIXTURE.gitcodeToken) && !request.url.includes(GIT_FIXTURE.githubToken));
    if (request.url === issuer + '/.well-known/jwks') return json({ keys: [jwk] });
    // Git smart-HTTP goes to the local git-http-backend pair; bodies stream through unchanged.
    if (url.origin === new URL(w.base).origin) return fetch(request.url, { method: request.method, headers: request.headers, body: request.body, duplex: 'half' });
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.endsWith('/installation')) return json({ id: url.pathname.includes(BOARD) ? 22 : 11 });
      if (url.pathname === '/app/installations/11/access_tokens') {
        assert.deepEqual((await request.json()).permissions, { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'write' });
        return json({ token: GIT_FIXTURE.githubToken, expires_at: new Date(Date.now() + 3600000).toISOString() });
      }
      if (url.pathname === '/app/installations/22/access_tokens') return json({ token: 'ghs_boardonly', expires_at: new Date(Date.now() + 3600000).toISOString() });
      if (url.pathname.endsWith('/dispatches')) return new Response(null, { status: 204 });
      assert.equal(request.headers.get('authorization'), 'Bearer ' + GIT_FIXTURE.githubToken);
      const body = await request.json();
      const id = /check-runs\/(\d+)$/.exec(url.pathname)?.[1];
      const check = id ? Object.assign(checks.get(Number(id)), body) : { id: checks.size + 1, ...body };
      checks.set(check.id, check);
      return json({ id: check.id }, id ? 200 : 201);
    }
    if (url.origin === 'https://gitcode.test') {
      assert.equal(request.headers.get('private-token'), GIT_FIXTURE.gitcodeToken);
      const path = url.pathname.replace('/api/v5', '');
      assert.ok(!/\/merge(\/|$)/.test(path), 'merge endpoint');
      if (path === `/repos/${TARGET}`) return json({ default_branch: 'main' });
      if (path === `/repos/${TARGET}/branches/main`) return json({ name: 'main' });
      if (path === `/repos/${TARGET}/commits`) return json([{ sha: w.ids.gitcodeOnly }, { sha: w.ids.common }]);
      if (path === `/repos/${TARGET}/pulls` && request.method === 'GET') return json([...pulls.values()].map(pullDoc));
      if (path === `/repos/${TARGET}/pulls` && request.method === 'POST') {
        const body = await request.json(), pull = { number: 21, title: body.title, body: body.body, state: 'open', head_ref: body.head, labels: [] };
        pulls.set(pull.number, pull); return json(pullDoc(pull), 201);
      }
      const item = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/commits|\/comments)?$/.exec(path), pull = item && pulls.get(Number(item[1]));
      if (pull && item[2] === '/commits') return json([{}, {}]);
      if (pull && item[2] === '/comments') return json(notes.get(pull.number) || []);
      if (pull) { if (request.method === 'PATCH') Object.assign(pull, await request.json()); return json(pullDoc(pull)); }
    }
    throw new Error('unexpected outbound request ' + request.url);
  };
  const bindings = { SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_ADMIN_TOKEN: 'local-test-admin', SDBOT_GITHUB_APP_ID: '123', SDBOT_GITHUB_APP_PRIVATE_KEY: await exportPKCS8(app.privateKey),
    SDBOT_REPOS: SOURCE, SDBOT_BOARD_TARGETS: JSON.stringify({ [SOURCE]: BOARD }), SDBOT_BOARD_REFRESH: '3600',
    SDBOT_ADMIN_HOSTNAME: 'localhost', SDBOT_ACTIONS_REPOSITORY_ID: '200', SDBOT_ACTIONS_OWNER_ID: '100', SDBOT_ACTIONS_AUDIENCE: 'sdbot:actions:test',
    // No SDBOT_GITCODE_SYNC_TARGET: the default target openJiuwen/sciencediscovery applies once the token is present.
    GITCODE_TOKEN: GIT_FIXTURE.gitcodeToken, SDBOT_GITCODE_USERNAME: GIT_FIXTURE.gitcodeUser, SDBOT_GITCODE_WEBHOOK_SECRET: secret,
    SDBOT_GITCODE_API_URL: 'https://gitcode.test/api/v5', SDBOT_GITCODE_WEB_URL: `${w.base}/gitcode`, SDBOT_GITHUB_WEB_URL: `${w.base}/github` };
  const mf = await workerRuntime({ directory, bindings, outboundService });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const admin = await mf.getWorker('admin'), headers = { authorization: 'Bearer local-test-admin' };
  const snapshot = async () => (await admin.fetch('http://localhost/api/gitcode-sync', { headers })).json();
  const deliver = async (payload, delivery) => {
    webhookPhase = true;
    try { const response = await mf.dispatchFetch('http://localhost/webhook/github', signed(payload, delivery)); assert.equal(response.status, 200); }
    finally { webhookPhase = false; }
  };

  const listeners = (await (await admin.fetch('http://localhost/api/listeners', { headers })).json()).listeners;
  assert.equal(listeners.find(l => l.id === 'gitcode_sync.on_pull_request').mode, 'active');
  const opened = await fixture('github_pull_request_opened.json');
  opened.pull_request.head.sha = w.ids.head;
  await deliver(opened, 'worker-sync-opened');
  await deliver(opened, 'worker-sync-opened');
  await until(async () => (await snapshot()).records.some(r => r.action === 'opened'));
  assert.equal(w.git(w.gitcode, 'rev-parse', 'refs/heads/github-pr/120'), w.ids.head, 'the GitHub SHA reached GitCode through workerd');
  w.git(w.gitcode, 'fsck', '--connectivity-only', '--no-dangling');
  assert.equal(w.git(w.gitcode, 'rev-parse', 'refs/heads/main'), w.ids.gitcodeOnly);
  let doc = await snapshot();
  assert.equal(doc.records.length, 1, 'the redelivered webhook did not sync twice');
  assert.equal(doc.records[0].status, 'success', JSON.stringify(doc.records[0])); assert.equal(doc.records[0].mr, 21);
  assert.equal(doc.pulls[0].check, 'pending');
  assert.equal([...checks.values()][0].status, 'in_progress');
  assert.equal(pulls.get(21).title, `[GitHub #120] feat(reader): stream long PDFs (${w.ids.head.slice(0, 7)})`);
  assert.equal(outbound.filter(line => line.endsWith('/pulls/21/comments')).length, 0, 'nothing polls GitCode after the sync');

  // The CI account's result comment arrives as a GitCode Note Hook; the alarm reads the verdict right away.
  pulls.get(21).labels = ['ci-successful'];
  notes.set(21, [{ id: 1, body: '&#9989; 流水线 0123456789abcdef 执行成功。', user: { login: 'openJiuwen-bot' }, created_at: new Date(Date.now() + 1000).toISOString(), html_url: `https://gitcode.test/${TARGET}/merge_requests/21#note_1` }]);
  const note = JSON.stringify({ object_kind: 'note', uuid: randomUUID(), user: { username: 'openJiuwen-bot' }, project: { path_with_namespace: TARGET },
    object_attributes: { id: 1, noteable_type: 'MergeRequest' }, merge_request: { iid: 21, source_branch: 'github-pr/120' } });
  webhookPhase = true;
  try {
    const response = await mf.dispatchFetch('http://localhost/webhook/gitcode', { method: 'POST', body: note, headers: { 'content-type': 'application/json', 'x-gitcode-event': 'Note Hook',
      'x-gitcode-delivery': randomUUID(), 'x-gitcode-signature-256': 'sha256=' + createHmac('sha256', secret).update(note).digest('hex') } });
    assert.equal(response.status, 200);
  } finally { webhookPhase = false; }
  await until(async () => [...checks.values()][0].conclusion === 'success');
  doc = await snapshot();
  assert.equal(doc.records[0].action, 'codecheck'); assert.equal(doc.records[0].status, 'success'); assert.equal(doc.pulls[0].check, 'success');

  const merged = await fixture('github_pull_request_merged.json');
  merged.pull_request.head.sha = w.ids.head;
  await deliver(merged);
  await until(async () => (await snapshot()).records.some(r => r.action === 'merged'));
  doc = await snapshot();
  assert.equal(pulls.get(21).state, 'closed'); assert.match(pulls.get(21).body, /Merged on GitHub/);
  assert.equal(doc.records[0].summary, '已在 GitHub 合并；已关闭 GitCode MR !21（未调用合并接口）');
  assert.equal(checks.size, 1); assert.equal([...checks.values()][0].conclusion, 'success', 'a written verdict is not cancelled by the merge');

  // The dashboard reads records with its collect.yml OIDC identity only.
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ iss: issuer, aud: 'sdbot:actions:test', sub: 'repo:ScienceDiscovery@100/github-status-board@200:ref:refs/heads/main', iat: now, nbf: now, exp: now + 300,
    jti: randomUUID(), repository: BOARD, repository_id: '200', repository_owner_id: '100', ref: 'refs/heads/main', ref_type: 'branch',
    workflow_ref: BOARD + '/.github/workflows/collect.yml@refs/heads/main', event_name: 'schedule', run_id: '300', run_attempt: '1' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(oidc.privateKey);
  assert.equal((await mf.dispatchFetch('http://localhost/actions/gitcode-sync', { method: 'POST' })).status, 401);
  assert.equal((await mf.dispatchFetch('http://localhost/actions/gitcode-sync')).status, 405);
  const records = await mf.dispatchFetch('http://localhost/actions/gitcode-sync', { method: 'POST', headers: { authorization: 'Bearer ' + jwt } });
  assert.equal(records.status, 200); assert.equal(records.headers.get('cache-control'), 'no-store');
  const published = await records.text(), body = JSON.parse(published);
  assert.equal(body.enabled, true); assert.equal(body.source, SOURCE); assert.equal(body.records.length, 3);
  for (const leaked of [GIT_FIXTURE.gitcodeToken, GIT_FIXTURE.githubToken, GIT_FIXTURE.gitcodeUser, 'Authorization']) assert.ok(!published.includes(leaked), leaked);
  // Credentials stay out of the delivery archive as well.
  const events = await (await admin.fetch('http://localhost/api/events', { headers })).json();
  assert.ok(!JSON.stringify(events).includes(GIT_FIXTURE.gitcodeToken));
  assert.ok(outbound.some(line => line.startsWith('POST ' + w.base + '/gitcode/') && line.endsWith('/git-receive-pack')));
});

test('Worker: missing GitHub credentials degrade sync and the board instead of answering 503', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const oidc = await generateKeyPair('RS256'), app = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(oidc.publicKey), kid: 'actions-key', alg: 'RS256', use: 'sig' };
  const outboundService = async request => {
    if (request.url === issuer + '/.well-known/jwks') return Response.json({ keys: [jwk] });
    throw new Error('no other outbound request is expected while credentials are missing: ' + request.url);
  };
  // Production-shaped: board targets, App ID as a plain var, the token present.
  const base = { SDBOT_ADMIN_TOKEN: 'local-test-admin', SDBOT_REPOS: SOURCE, SDBOT_BOARD_TARGETS: JSON.stringify({ [SOURCE]: BOARD }),
    SDBOT_ADMIN_HOSTNAME: 'localhost', SDBOT_ACTIONS_REPOSITORY_ID: '200', SDBOT_ACTIONS_OWNER_ID: '100', SDBOT_ACTIONS_AUDIENCE: 'sdbot:actions:test',
    SDBOT_GITHUB_APP_ID: '123', GITCODE_TOKEN: GIT_FIXTURE.gitcodeToken };
  const now = Math.floor(Date.now() / 1000);
  const jwt = () => new SignJWT({ iss: issuer, aud: 'sdbot:actions:test', sub: 'repo:ScienceDiscovery@100/github-status-board@200:ref:refs/heads/main', iat: now, nbf: now, exp: now + 300,
    jti: randomUUID(), repository: BOARD, repository_id: '200', repository_owner_id: '100', ref: 'refs/heads/main', ref_type: 'branch',
    workflow_ref: BOARD + '/.github/workflows/collect.yml@refs/heads/main', event_name: 'schedule', run_id: '300', run_attempt: '1' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(oidc.privateKey);
  const run = async (bindings, expected) => {
    const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-degrade-'));
    const mf = await workerRuntime({ directory, bindings, outboundService });
    t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
    const admin = await mf.getWorker('admin'), headers = { authorization: 'Bearer local-test-admin' };
    assert.equal((await mf.dispatchFetch('http://localhost/healthz')).status, 200, 'the Worker serves instead of answering 503');
    const status = await (await admin.fetch('http://localhost/api/status', { headers })).json();
    assert.deepEqual(status.gitcode_sync, { enabled: false, reason: expected.join(','), reasons: expected });
    const listener = (await (await admin.fetch('http://localhost/api/listeners', { headers })).json()).listeners.find(l => l.id === 'gitcode_sync.on_pull_request');
    assert.equal(listener.mode, 'disabled');
    const records = await mf.dispatchFetch('http://localhost/actions/gitcode-sync', { method: 'POST', headers: { authorization: 'Bearer ' + await jwt() } });
    assert.equal(records.status, 200);
    assert.deepEqual(await records.json(), { ok: true, enabled: false, reason: expected.join(','), reasons: expected, records: [], pulls: [] });
    return { mf, status, listener };
  };
  // App key and every webhook secret missing: both reasons, nothing hidden behind a 503.
  const both = await run(base, ['no_github_app', 'no_webhook_secret']);
  assert.match(both.listener.description, /缺少 GitHub App 凭据.*；缺少 GitHub Webhook secret.*GitCode 同步已停用/);
  assert.deepEqual({ enabled: both.status.board.enabled, reason: both.status.board.reason }, { enabled: false, reason: 'no_github_app' });
  const body = JSON.stringify({ action: 'opened', repository: { full_name: SOURCE } });
  const unsigned = await both.mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': randomUUID() } });
  assert.equal(unsigned.status, 401, 'a missing secret still rejects deliveries; it never accepts them unsigned');
  assert.equal((await both.mf.dispatchFetch('http://localhost/actions/token', { method: 'POST', headers: { authorization: 'Bearer ' + await jwt() }, body: '{"purpose":"source"}' })).status, 503, 'no App, no token exchange');
  // Only the webhook secret missing: the board still collects; sync says exactly what is missing.
  const secretOnly = await run({ ...base, SDBOT_GITHUB_APP_PRIVATE_KEY: await exportPKCS8(app.privateKey) }, ['no_webhook_secret']);
  assert.equal(secretOnly.status.board.enabled, true);
  assert.equal(secretOnly.listener.description, '缺少 GitHub Webhook secret（SDBOT_GITHUB_WEBHOOK_SECRET），GitCode 同步已停用。');
});
