import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { workerRuntime } from '../tools/worker-runtime.mjs';

const issuer = 'https://token.actions.githubusercontent.com', source = 'example/source', destination = 'example/board';
const secret = 'isolated-rerun-webhook';

test('completed reruns coalesce durably without accelerating collection; acknowledgements are revision-bound', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/run-changes-'));
  const oidc = await generateKeyPair('RS256');
  const key = { ...await exportJWK(oidc.publicKey), kid: 'rerun-key', alg: 'RS256', use: 'sig' };
  const bindings = { SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_GITHUB_APP_ID: '123', SDBOT_GITHUB_APP_PRIVATE_KEY: 'isolated-placeholder',
    SDBOT_REPOS: source, SDBOT_BOARD_TARGETS: JSON.stringify({ [source]: destination }), SDBOT_ADMIN_HOSTNAME: 'localhost',
    SDBOT_BOARD_DEBOUNCE: '600', SDBOT_ACTIONS_REPOSITORY_ID: '200', SDBOT_ACTIONS_OWNER_ID: '100', SDBOT_ACTIONS_AUDIENCE: 'reruns:test' };
  const start = () => workerRuntime({ directory, entry: 'tests-ts/support/worker-run-changes-control.mjs', bindings,
    outboundService: request => {
      assert.equal(request.url, issuer + '/.well-known/jwks', 'reruns must not dispatch new collections or mint tokens');
      return Response.json({ keys: [key] });
    } });
  let mf = await start();
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const token = (extra = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: issuer, aud: 'reruns:test', sub: `repo:${destination}:ref:refs/heads/main`, iat: now, nbf: now, exp: now + 300,
      jti: randomUUID(), repository: destination, repository_id: '200', repository_owner_id: '100', ref: 'refs/heads/main', ref_type: 'branch',
      workflow_ref: `${destination}/.github/workflows/collect.yml@refs/heads/main`, event_name: 'workflow_dispatch', run_id: '400', run_attempt: '1', ...extra })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid }).sign(oidc.privateKey);
  };
  const jwt = await token();
  const api = (path = '', body = {}, authorization = jwt, method = 'POST') => mf.dispatchFetch('http://localhost/actions/reruns' + path,
    { method, headers: { authorization: 'Bearer ' + authorization, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  const list = async () => { const r = await api(); assert.equal(r.status, 200); const value = await r.json(); assert.equal(value.source, source); return value.runs; };
  const state = async () => (await mf.dispatchFetch('http://localhost/_test/rerun-state')).json();
  const send = async (id, attempt, extra = {}, delivery = randomUUID(), signing = secret, repository = source) => {
    const body = JSON.stringify({ action: 'completed', repository: { full_name: repository }, workflow_run: { id, run_attempt: attempt, status: 'completed', ...extra } });
    return mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', body, headers: { 'x-github-event': 'workflow_run',
      'x-github-delivery': delivery, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', signing).update(body).digest('hex') } });
  };
  await t.test('only the fixed collector can read or acknowledge this source', async () => {
    assert.equal((await api('', {}, 'invented')).status, 401);
    assert.equal((await api('', {}, jwt, 'GET')).status, 405);
    for (const claims of [{ repository: 'other/board' }, { repository_id: '201' }, { repository_owner_id: '101' }, { ref: 'refs/heads/develop' },
      { event_name: 'push' }, { workflow_ref: `${destination}/.github/workflows/evil.yml@refs/heads/main` },
      { job_workflow_ref: `other/reusable/.github/workflows/a.yml@refs/heads/main` }])
      assert.equal((await api('', {}, await token(claims))).status, 403);
    assert.equal((await api('', { source: 'other/source' })).status, 400);
    assert.equal((await api('/ack', { runs: [], commit: 'bad' })).status, 400);
    assert.deepEqual(await list(), []);
  });
  await t.test('first attempts, invalid input and untrusted deliveries create no hints', async () => {
    await send(1, 1); await send(2, 2, { status: 'in_progress' }); await send('3', 2); await send(3, true);
    await send(4, 2, {}, randomUUID(), 'wrong-secret');
    await send(5, 2, {}, randomUUID(), secret, 'other/source');
    assert.deepEqual(await list(), []);
  });
  await t.test('reruns change neither the eight-hour schedule nor a pending Issue refresh', async () => {
    const before = await state(), delivery = randomUUID();
    assert.equal((await send(42, 2, {}, delivery)).status, 200);
    await send(42, 2, {}, delivery); await send(42, 2); await send(42, 1);
    const rows = await list(); assert.equal(rows.length, 1); assert.equal(rows[0].attempt, 2);
    assert.deepEqual(await state(), before);
    const body = JSON.stringify({ action: 'opened', repository: { full_name: source }, issue: { number: 9 } });
    await mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', body, headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(),
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } });
    const issueState = await state(); assert.equal(issueState.outbox[0].requested, 1);
    await send(42, 3); assert.deepEqual(await state(), issueState, 'completion does not restart debounce or add a generation');
    const current = (await list())[0];
    assert.notEqual(current.revision, rows[0].revision);
    assert.equal((await api('/ack', { commit: 'a'.repeat(40), runs: rows })).status, 200);
    assert.deepEqual(await list(), [current], 'a late acknowledgement cannot remove a newer attempt');
    await api('/ack', { commit: 'a'.repeat(40), runs: [{ ...current, revision: '0'.repeat(32) }] });
    assert.deepEqual(await list(), [current]);
  });
  await t.test('pending hints survive restart; only a matching acknowledgement removes them', async () => {
    const rows = await list();
    await mf.dispose(); mf = await start();
    assert.deepEqual(await list(), rows);
    assert.equal((await api('/ack', { commit: 'b'.repeat(40), runs: rows })).status, 200);
    assert.deepEqual(await list(), []);
  });
  await t.test('small batches rotate fairly even when failed items remain pending', async () => {
    for (let id = 100; id < 133; id++) await send(id, 2);
    const first = await list(), second = await list();
    assert.equal(first.length, 20); assert.equal(second.length, 20);
    assert.equal(new Set([...first, ...second].map(row => row.id)).size, 33);
    assert.equal((await api('/ack', { commit: 'a'.repeat(40), runs: Array(21).fill(first[0]) })).status, 400);
    assert.equal((await api('/ack', { commit: 'a'.repeat(40), runs: [{ ...first[0], id: '../evil' }] })).status, 400);
  });
  await t.test('staged changes are not visible until the archive transaction commits', async () => {
    const result = await (await mf.dispatchFetch('http://localhost/_test/rerun-rollback')).json();
    assert.ok(!result.before.some(row => row.id === 999001));
    assert.ok(!result.after.some(row => row.id === 999001));
  });
});
