import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { boardBlocked, configFromEnv, publicConfig, validateConfig, type Environment } from '../src/core/config.js';
import { NoopBoard, NoopSync, Router } from '../src/core/bus.js';
import { Pipeline } from '../src/core/pipeline.js';
import { BotApplication } from '../src/core/http.js';
import { basicAuthorization, GitTransferError, type PushResult } from '../src/core/git-http.js';
import { evaluateCodeCheck, scrub, syncContext, type SyncRecord } from '../src/core/gitcode-sync.js';
import { FileArchive } from '../src/node/archive.js';
import { NodeGitCodeSync } from '../src/node/gitcode-sync.js';
import { normalize } from '../src/core/events.js';
import { object, type Doc } from '../src/core/types.js';
import { delivery, secret } from './helpers.js';

// Fake credentials only. No request in this file leaves the process.
const GITCODE_TOKEN = 'gitcode-fake-token-not-real-0123456789';
const INSTALLATION_TOKEN = 'ghs_FAKEINSTALLATIONTOKEN0123456789abcdef';
const SOURCE = 'openJiuwen-ai/sciencediscovery', TARGET = 'openJiuwen/sciencediscovery';
const A = 'a'.repeat(39) + '1', B = 'b'.repeat(39) + '2';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const fixture = async (name: string): Promise<Doc> => JSON.parse(await readFile(resolve('tests-ts/fixtures/gitcode-sync', name), 'utf8')) as Doc;
const comments = await fixture('gitcode_comments.json');
const env = (extra: Environment = {}): Environment => ({ SDBOT_REPOS: SOURCE, SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_GITHUB_APP_ID: '42', SDBOT_GITHUB_APP_PRIVATE_KEY: PEM,
  SDBOT_GITCODE_SYNC_TARGET: TARGET, GITCODE_TOKEN, SDBOT_GITCODE_USERNAME: 'sync-bot', SDBOT_GITCODE_API_URL: 'https://gitcode.test/api/v5',
  SDBOT_GITCODE_WEB_URL: 'https://gitcode.test', SDBOT_GITHUB_WEB_URL: 'https://github.test', ...extra });

interface Pull { number: number; title: string; body: string; state: string; head_ref: string; head_sha: string; labels: string[]; commits: number | null }
interface Check { id: number; head_sha: string; name: string; status: string; conclusion?: string; title: string; summary: string; details_url?: string; external_id: string }
/** In-memory GitHub API, GitCode REST and git push. Every request is checked for credential placement. */
class World {
  readonly calls: string[] = [];
  readonly checks = new Map<number, Check>();
  readonly pulls = new Map<number, Pull>();
  readonly comments = new Map<number, Doc[]>();
  readonly pushes: { sha: string; ref: string }[] = [];
  readonly branches = new Map<string, string>();
  failPush: Error | null = null;
  failApi: { method: string; path: RegExp; status: number } | null = null;
  private nextCheck = 100;
  private nextPull = 11;
  private json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  private pullDoc = (p: Pull) => ({ number: p.number, title: p.title, body: p.body, state: p.state, html_url: `https://gitcode.test/${TARGET}/merge_requests/${p.number}`,
    head: { ref: p.head_ref, sha: p.head_sha, repo: { full_name: TARGET } }, base: { ref: 'main' }, labels: p.labels.map(name => ({ name })) });
  fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = (init.method || 'GET').toUpperCase(), headers = new Headers(init.headers);
    this.calls.push(`${method} ${url.origin}${url.pathname}`);
    assert.ok(!url.toString().includes(GITCODE_TOKEN) && !url.toString().includes(INSTALLATION_TOKEN), 'tokens never travel in URLs');
    assert.equal(init.redirect, 'manual');
    const body = init.body ? object(JSON.parse(String(init.body))) : {};
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === `/repos/${SOURCE}/installation`) return this.json({ id: 7 });
      if (url.pathname === '/app/installations/7/access_tokens') {
        assert.deepEqual(body.permissions, { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'write' });
        assert.deepEqual(body.repositories, ['sciencediscovery']);
        return this.json({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600000).toISOString() });
      }
      assert.equal(headers.get('authorization'), `Bearer ${INSTALLATION_TOKEN}`);
      const output = object(body.output);
      if (method === 'POST' && url.pathname === `/repos/${SOURCE}/check-runs`) {
        const check: Check = { id: this.nextCheck++, head_sha: String(body.head_sha), name: String(body.name), status: String(body.status), conclusion: body.conclusion as string | undefined,
          title: String(output.title), summary: String(output.summary), details_url: body.details_url as string | undefined, external_id: String(body.external_id) };
        this.checks.set(check.id, check); return this.json({ id: check.id }, 201);
      }
      const patched = /^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(url.pathname);
      if (method === 'PATCH' && patched) {
        const check = this.checks.get(Number(patched[1]))!;
        Object.assign(check, { status: body.status, conclusion: body.conclusion, title: output.title, summary: output.summary, details_url: body.details_url ?? check.details_url });
        return this.json({ id: check.id });
      }
    }
    if (url.origin === 'https://gitcode.test') {
      assert.equal(headers.get('private-token'), GITCODE_TOKEN);
      const path = url.pathname.replace('/api/v5', '');
      assert.ok(!/\/merge(\/|$)/.test(path), 'the GitCode merge endpoint must never be called');
      if (this.failApi && this.failApi.method === method && this.failApi.path.test(path))
        return this.json({ error_message: `denied for token=${GITCODE_TOKEN} with Authorization: Bearer ${INSTALLATION_TOKEN} via https://sync-bot:${GITCODE_TOKEN}@gitcode.test/x.git` }, this.failApi.status);
      if (path === `/repos/${TARGET}`) return this.json({ default_branch: 'main' });
      if (path === `/repos/${TARGET}/branches/main`) return this.json({ name: 'main' });
      if (path === `/repos/${TARGET}/commits`) return this.json([{ sha: 'c'.repeat(40) }]);
      if (path === `/repos/${TARGET}/pulls` && method === 'GET') return this.json([...this.pulls.values()].map(this.pullDoc));
      if (path === `/repos/${TARGET}/pulls` && method === 'POST') {
        assert.equal(body.base, 'main'); assert.equal(body.head, 'github-pr/120');
        const pull: Pull = { number: this.nextPull++, title: String(body.title), body: String(body.body), state: 'open', head_ref: String(body.head),
          head_sha: this.branches.get('refs/heads/github-pr/120') || '', labels: [], commits: null };
        this.pulls.set(pull.number, pull); return this.json(this.pullDoc(pull), 201);
      }
      const item = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/commits|\/comments)?$/.exec(path);
      if (item) {
        const pull = this.pulls.get(Number(item[1]));
        if (!pull) return this.json({ error_message: 'not found' }, 404);
        if (item[2] === '/commits') return this.json(Array.from({ length: pull.commits ?? 2 }, (_, i) => ({ sha: String(i).padStart(40, '0') })));
        if (item[2] === '/comments') return this.json(this.comments.get(pull.number) || []);
        if (method === 'PATCH') {
          if (body.title) pull.title = String(body.title);
          if (body.body) pull.body = String(body.body);
          if (body.state) pull.state = String(body.state);
        }
        return this.json(this.pullDoc(pull));
      }
    }
    throw new Error(`unexpected outbound request ${method} ${url}`);
  }) as typeof fetch;
  push = async (options: { sha: string; ref: string; source: { authorization: string }; target: { authorization: string } }): Promise<PushResult> => {
    assert.equal(options.target.authorization, basicAuthorization('sync-bot', GITCODE_TOKEN));
    assert.equal(options.source.authorization, basicAuthorization('x-access-token', INSTALLATION_TOKEN));
    if (this.failPush) throw this.failPush;
    const old = this.branches.get(options.ref) || '0'.repeat(40);
    // Like pushCommit: a branch already at the SHA needs no transfer.
    if (old === options.sha) return { status: 'unchanged', old, new: options.sha, ref: options.ref };
    this.pushes.push({ sha: options.sha, ref: options.ref });
    this.branches.set(options.ref, options.sha);
    for (const pull of this.pulls.values()) if (`refs/heads/${pull.head_ref}` === options.ref) pull.head_sha = options.sha;
    return { status: old === options.sha ? 'unchanged' : 'pushed', old, new: options.sha, ref: options.ref };
  };
  checksFor(sha: string): Check[] { return [...this.checks.values()].filter(c => c.head_sha === sha); }
  comment(pr: number, kind: 'cla' | 'running' | 'passed' | 'failed', at: number): void {
    const list = this.comments.get(pr) || [];
    list.push({ ...object(comments[kind]), id: list.length + 1, created_at: new Date(at).toISOString(), html_url: `https://gitcode.test/${TARGET}/merge_requests/${pr}#note_${list.length + 1}` });
    this.comments.set(pr, list);
  }
}

async function setup(extra: Environment = {}) {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/gitcode-sync-'));
  const cfg = { ...configFromEnv(env(extra), resolve('.')), data_dir: directory };
  assert.deepEqual(validateConfig(cfg), []);
  const world = new World();
  let clock = Date.now();
  const sync = await NodeGitCodeSync.open(cfg, () => ({ ...syncContext(cfg, world.fetcher, () => clock), push: world.push as never }));
  const archive = await FileArchive.open(directory, cfg.dedupe_window);
  const app = new BotApplication(new Pipeline(cfg, archive, new Router(undefined, sync)), async () => '');
  const send = async (name: string, deliveryId = randomUUID()): Promise<Doc> => {
    const { payload } = await fixture(name);
    const response = await app.webhook((await delivery('pull_request', object(payload), { delivery: deliveryId, path: '/webhook/github' })).request());
    assert.equal(response.status, 200);
    return (await archive.recent(1))[0];
  };
  const listener = (record: Doc): string => String(object((record.listeners as Doc[] || []).find(l => object(l).id === 'gitcode_sync.on_pull_request')).status ?? '');
  /** Advance the queue clock and drain everything due at that time. */
  const tick = async (ms = 0): Promise<void> => { clock = Math.max(clock, Date.now()) + ms; while (await sync.tick(clock)) { /* drain */ } };
  const records = async (): Promise<SyncRecord[]> => (await sync.snapshot()).records as SyncRecord[];
  return { cfg, world, sync, app, send, listener, tick, records, now: () => clock, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const POLL = 121000;

test('opened: the webhook only queues; the queue pushes the original head and opens a GitCode MR with an in-progress Check', async t => {
  const h = await setup(); t.after(h.cleanup);
  const record = await h.send('github_pull_request_opened.json');
  assert.equal(h.listener(record), 'queued');
  assert.ok(String(record.hooks).includes('gitcode_sync.on_pull_request'));
  assert.deepEqual(h.world.calls, [], 'no GitHub/GitCode call happens inside the webhook request');
  await h.tick();
  assert.deepEqual(h.world.pushes, [{ sha: A, ref: 'refs/heads/github-pr/120' }]);
  const pull = h.world.pulls.get(11)!;
  assert.match(pull.title, /^\[GitHub #120\] feat\(reader\): stream long PDFs \(aaaaaaa\)$/);
  assert.ok(pull.body.includes(`https://github.com/${SOURCE}/pull/120`) && pull.body.includes(A), 'MR body names the PR and the full head SHA');
  assert.ok(pull.body.includes('Do not merge this merge request on GitCode'));
  const [check] = h.world.checksFor(A);
  assert.equal(check.name, 'CodeCheck (GitCode)'); assert.equal(check.status, 'in_progress'); assert.equal(check.conclusion, undefined);
  assert.equal(check.title, 'Waiting for CodeCheck on GitCode');
  assert.match(check.summary, /GitCode has no CodeCheck verdict yet/);
  assert.equal(check.details_url, `https://gitcode.test/${TARGET}/merge_requests/11`);
  const [first] = await h.records();
  assert.equal(first.action, 'opened'); assert.equal(first.status, 'success'); assert.equal(first.mr, 11);
  assert.equal(first.mr_url, `https://gitcode.test/${TARGET}/merge_requests/11`); assert.match(first.summary, /已推送原始 head aaaaaaa/);
});

test('CodeCheck read-back: no result and stale labels stay in progress; ci-successful passes; ci-failed fails a newer head', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  const pull = h.world.pulls.get(11)!;
  // A label left by an earlier run on the same MR is not evidence for this head.
  pull.labels = ['ci-successful'];
  h.world.comment(11, 'passed', h.now() - 3600000);
  await h.tick(POLL);
  let [check] = h.world.checksFor(A);
  assert.equal(check.status, 'in_progress'); assert.match(check.summary, /GitCode has no CodeCheck verdict yet/); assert.match(check.summary, /predates this head/);
  pull.labels = ['ci-running']; h.world.comment(11, 'cla', h.now()); h.world.comment(11, 'running', h.now());
  await h.tick(POLL);
  [check] = h.world.checksFor(A);
  assert.equal(check.status, 'in_progress'); assert.match(check.summary, /running on GitCode/);
  pull.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now() + 1000);
  await h.tick(POLL);
  [check] = h.world.checksFor(A);
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'success'); assert.equal(check.title, 'CodeCheck passed on GitCode');
  assert.equal((await h.records())[0].action, 'codecheck'); assert.equal((await h.records())[0].status, 'success');
  // New head: the MR still carries the old success, which must not leak onto B.
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  assert.deepEqual(h.world.pushes.at(-1), { sha: B, ref: 'refs/heads/github-pr/120' });
  assert.match(pull.title, /\(bbbbbbb\)$/); assert.ok(pull.body.includes(B));
  await h.tick(POLL);
  let [checkB] = h.world.checksFor(B);
  assert.equal(checkB.status, 'in_progress'); assert.equal(h.world.checksFor(A)[0].conclusion, 'success');
  pull.labels = ['ci-failed']; h.world.comment(11, 'running', h.now()); h.world.comment(11, 'failed', h.now() + 2000);
  await h.tick(POLL);
  [checkB] = h.world.checksFor(B);
  assert.equal(checkB.status, 'completed'); assert.equal(checkB.conclusion, 'failure'); assert.equal(checkB.title, 'CodeCheck failed on GitCode');
  const latest = (await h.records())[0];
  assert.equal(latest.status, 'error'); assert.equal(latest.error_code, 'codecheck_failed');
});

test('closed and merged only close the GitCode MR; reopen reopens it; the merge endpoint is never called', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  assert.equal(h.world.checksFor(A)[0].conclusion, 'cancelled', 'the replaced head no longer waits');
  await h.send('github_pull_request_closed.json'); await h.tick();
  const pull = h.world.pulls.get(11)!;
  assert.equal(pull.state, 'closed'); assert.match(pull.body, /\*\*Closed on GitHub\*\*/);
  let [checkB] = h.world.checksFor(B);
  assert.equal(checkB.conclusion, 'cancelled'); assert.equal(checkB.title, 'Pull request closed on GitHub');
  assert.equal((await h.records())[0].summary, 'GitHub PR 已关闭；已关闭 GitCode MR !11');
  await h.send('github_pull_request_reopened.json'); await h.tick();
  assert.equal(pull.state, 'open'); assert.equal(h.world.pushes.length, 2, 'the branch already holds B; reopen does not push again');
  const waiting = h.world.checksFor(B).filter(c => c.status === 'in_progress');
  assert.equal(waiting.length, 1, 'a completed check run is not reopened; waiting again uses a new run');
  await h.send('github_pull_request_merged.json'); await h.tick();
  assert.equal(pull.state, 'closed');
  assert.match(pull.body, /\*\*Merged on GitHub\*\* as `d{40}`/); assert.match(pull.body, /Closed here without merging/);
  const merged = (await h.records())[0];
  assert.equal(merged.action, 'merged'); assert.equal(merged.status, 'success');
  assert.equal(merged.summary, '已在 GitHub 合并；已关闭 GitCode MR !11（未调用合并接口）');
  assert.ok(!h.world.calls.some(call => /\/merge(\/|$)/.test(call)));
  [checkB] = h.world.checksFor(B).filter(c => c.id === waiting[0].id);
  assert.equal(checkB.conclusion, 'cancelled'); assert.equal(checkB.title, 'Pull request merged on GitHub');
});

test('duplicate and stale deliveries are idempotent; nothing is pushed or created twice', async t => {
  const h = await setup(); t.after(h.cleanup);
  const id = randomUUID();
  assert.equal(h.listener(await h.send('github_pull_request_opened.json', id)), 'queued');
  const again = await h.send('github_pull_request_opened.json', id);
  assert.equal(again.duplicate, true, 'a platform redelivery of the same delivery id reaches no listener');
  await h.tick();
  assert.equal(h.listener(await h.send('github_pull_request_opened.json')), 'duplicate', 'same action and head under a new delivery id');
  await h.tick(POLL);
  assert.equal(h.world.pushes.length, 1); assert.equal(h.world.pulls.size, 1);
  assert.equal(h.world.calls.filter(c => c === `POST https://gitcode.test/api/v5/repos/${TARGET}/pulls`).length, 1);
  await h.send('github_pull_request_synchronize.json');
  assert.equal(h.listener(await h.send('github_pull_request_opened.json')), 'stale', 'an older event cannot roll the head back');
  await h.tick();
  assert.deepEqual(h.world.pushes.map(p => p.sha), [A, B]);
  assert.equal((await h.records()).filter(r => r.status === 'success' && r.action !== 'codecheck').length, 2);
});

test('GitCode failures are sync errors with scrubbed text, never success; transient ones retry', async t => {
  const h = await setup(); t.after(h.cleanup);
  h.world.failApi = { method: 'POST', path: /\/pulls$/, status: 503 };
  await h.send('github_pull_request_opened.json'); await h.tick();
  let [record] = await h.records();
  assert.equal(record.status, 'error'); assert.equal(record.error_code, 'gitcode_error');
  assert.match(record.summary, /第 1 次，稍后重试/);
  assert.match(String(record.error), /GitCode merge request creation returned HTTP 503/);
  let [check] = h.world.checksFor(A);
  assert.equal(check.status, 'in_progress'); assert.equal(check.title, 'Retrying sync to GitCode');
  h.world.failApi = null;
  await h.tick(61000);
  [record] = await h.records();
  assert.equal(record.status, 'success');
  // Permission problems are not retried and fail the gate for this head.
  h.world.failPush = new GitTransferError('permission_denied', 'GitCode receive-pack returned HTTP 403: credentials rejected or missing permission', 403);
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  [record] = await h.records();
  assert.equal(record.status, 'error'); assert.equal(record.error_code, 'permission_denied'); assert.match(record.summary, /已停止重试/);
  [check] = h.world.checksFor(B);
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'failure'); assert.equal(check.title, 'Sync to GitCode failed');
  // Redelivering after a failure is the manual retry.
  h.world.failPush = null;
  assert.equal(h.listener(await h.send('github_pull_request_synchronize.json')), 'queued');
  await h.tick();
  assert.equal((await h.records())[0].status, 'success');
  const published = JSON.stringify(await h.sync.snapshot());
  for (const secretValue of [GITCODE_TOKEN, INSTALLATION_TOKEN, 'sync-bot:', 'Authorization: Bearer', PEM.slice(40, 80)]) assert.ok(!published.includes(secretValue), `snapshot leaks ${secretValue.slice(0, 12)}`);
  const sent = [...h.world.checks.values()].map(c => c.summary + c.title).join('\n');
  assert.ok(!sent.includes(GITCODE_TOKEN) && !sent.includes(INSTALLATION_TOKEN));
});

test('error bodies that echo credentials are scrubbed before they are stored', async t => {
  const h = await setup(); t.after(h.cleanup);
  h.world.failApi = { method: 'GET', path: /\/branches\/main$/, status: 401 };
  await h.send('github_pull_request_opened.json'); await h.tick();
  const [record] = await h.records();
  assert.equal(record.error_code, 'permission_denied');
  assert.match(String(record.error), /HTTP 401/);
  for (const leaked of [GITCODE_TOKEN, INSTALLATION_TOKEN, 'sync-bot:']) assert.ok(!String(record.error).includes(leaked));
  assert.ok(String(record.error).includes('[REDACTED]'));
  const admin = await h.app.admin(new Request('http://localhost/api/gitcode-sync'));
  const text = await admin.text();
  assert.equal(admin.status, 200); assert.ok(!text.includes(GITCODE_TOKEN) && !text.includes(INSTALLATION_TOKEN));
});

test('diverged history still pushes the original SHA and records that the GitCode diff may include other commits', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json');
  h.world.branches.set('refs/heads/github-pr/120', '0'.repeat(40));
  await h.tick();
  h.world.pulls.get(11)!.commits = 9;
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  assert.equal(h.world.pushes.at(-1)!.sha, B, 'the original head is pushed; nothing is rebased');
  const [record] = await h.records();
  assert.equal(record.status, 'error'); assert.equal(record.error_code, 'history_diverged');
  assert.match(String(record.error), /lists 9 commits but GitHub PR #120 has 3; the GitCode diff may include commits outside this PR/);
  assert.match(record.summary, /GitCode diff 可能包含本 PR 以外的提交/);
  const [check] = h.world.checksFor(B);
  assert.equal(check.status, 'in_progress'); assert.match(check.summary, /may include commits outside this pull request/);
  const pulls = (await h.sync.snapshot()).pulls as Doc[];
  assert.equal(pulls[0].sync_status, 'diverged');
});

test('no verdict within the timeout completes the Check as timed_out, never success', async t => {
  const h = await setup({ SDBOT_GITCODE_VERDICT_TIMEOUT: '600' }); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  h.world.pulls.get(11)!.labels = ['ci-successful'];
  for (let i = 0; i < 5; i++) await h.tick(POLL);
  const [check] = h.world.checksFor(A);
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'timed_out'); assert.equal(check.title, 'No CodeCheck verdict from GitCode');
  const [record] = await h.records();
  assert.equal(record.error_code, 'codecheck_timeout');
});

test('pull requests to bases outside the sync scope are skipped and visible', async t => {
  const h = await setup({ SDBOT_GITCODE_SYNC_BASES: 'release' }); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  assert.equal(h.world.pushes.length, 0);
  const [record] = await h.records();
  assert.equal(record.status, 'skipped'); assert.match(record.summary, /不在同步范围/);
});

test('verdict rules: labels decide, a fresh CI result comment proves the label belongs to this head', () => {
  const pushedAt = Date.parse('2026-10-07T06:00:00Z');
  const c = (kind: string, at: string, author = 'openJiuwen-bot') => ({ id: kind, body: String(object(comments[kind]).body), author, created_at: Date.parse(at), url: '' });
  const base = { pushedAt, mrHeadSha: A, expectedSha: A, ciBot: 'openJiuwen-bot' };
  assert.equal(evaluateCodeCheck({ ...base, labels: [], comments: [] }).state, 'pending');
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-successful'], comments: [c('passed', '2026-10-07T05:00:00Z')] }).state, 'pending');
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-successful'], comments: [c('passed', '2026-10-07T06:10:00Z', 'someone-else')] }).state, 'pending');
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-successful'], comments: [c('cla', '2026-10-07T06:10:00Z')] }).state, 'pending');
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-successful'], comments: [c('passed', '2026-10-07T06:10:00Z')] }).state, 'success');
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-failed'], comments: [c('failed', '2026-10-07T06:10:00Z')] }).state, 'failure');
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-running', 'ci-successful'], comments: [c('passed', '2026-10-07T06:10:00Z')] }).state, 'pending');
  // A rerun started after the last result invalidates that result.
  assert.equal(evaluateCodeCheck({ ...base, labels: ['ci-successful'], comments: [c('passed', '2026-10-07T06:10:00Z'), c('running', '2026-10-07T06:20:00Z')] }).state, 'pending');
  assert.equal(evaluateCodeCheck({ ...base, mrHeadSha: B, labels: ['ci-successful'], comments: [c('passed', '2026-10-07T06:10:00Z')] }).state, 'pending');
});

test('scrub removes tokens, Authorization values and credentialed URLs', () => {
  const text = scrub(`fatal https://user:${GITCODE_TOKEN}@gitcode.com/x.git Authorization: Basic c3luYzpzZWNyZXQ= PRIVATE-TOKEN=abc123456 access_token=xyz987654 ${INSTALLATION_TOKEN}\nnext`, [GITCODE_TOKEN]);
  for (const leaked of [GITCODE_TOKEN, 'user:', 'c3luYzpzZWNyZXQ=', 'abc123456', 'xyz987654', INSTALLATION_TOKEN]) assert.ok(!text.includes(leaked), leaked);
  assert.ok(!text.includes('\n'));
});

const syncListener = (router: Router) => router.bus.inventory().find(l => l.id === 'gitcode_sync.on_pull_request')!;
const appEnv: Environment = { SDBOT_REPOS: SOURCE, SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_GITHUB_APP_ID: '42', SDBOT_GITHUB_APP_PRIVATE_KEY: PEM };

test('defaults: with a token and neither target nor username set, sync is enabled for openJiuwen/sciencediscovery as openJiuwen-bot', async t => {
  const cfg = configFromEnv({ ...appEnv, GITCODE_TOKEN });
  assert.equal(cfg.gitcode_sync.enabled, true); assert.deepEqual(cfg.gitcode_sync.disabled_reasons, []);
  assert.equal(cfg.gitcode_sync.target, 'openJiuwen/sciencediscovery'); assert.equal(cfg.gitcode_sync.push_repo, 'openJiuwen/sciencediscovery');
  assert.equal(cfg.gitcode_sync.username, 'openJiuwen-bot'); assert.equal(cfg.gitcode_sync.source, SOURCE);
  assert.deepEqual(validateConfig(cfg), [], 'a default username is a valid configuration');
  // A blank variable means "not set", not "off".
  assert.equal(configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_SYNC_TARGET: ' ', SDBOT_GITCODE_USERNAME: '' }).gitcode_sync.target, 'openJiuwen/sciencediscovery');
  // The defaults drive a whole sync: the push authenticates as openJiuwen-bot and the MR opens on the default target.
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/gitcode-defaults-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const hubCfg = { ...configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_API_URL: 'https://gitcode.test/api/v5', SDBOT_GITCODE_WEB_URL: 'https://gitcode.test',
    SDBOT_GITHUB_WEB_URL: 'https://github.test' }), data_dir: directory };
  const world = new World();
  const push = async (options: Parameters<World['push']>[0] & { target: { url: string; authorization: string } }) => {
    assert.equal(options.target.authorization, basicAuthorization('openJiuwen-bot', GITCODE_TOKEN));
    assert.equal(options.target.url, 'https://gitcode.test/openJiuwen/sciencediscovery.git');
    // The in-memory GitCode below checks for its own fixture account; translate after asserting the default.
    return world.push({ ...options, target: { authorization: basicAuthorization('sync-bot', GITCODE_TOKEN) } });
  };
  const sync = await NodeGitCodeSync.open(hubCfg, () => ({ ...syncContext(hubCfg, world.fetcher), push: push as never }));
  assert.equal(syncListener(new Router(undefined, sync)).mode, 'active');
  const { payload } = await fixture('github_pull_request_opened.json');
  const event = normalize('github', new Headers({ 'x-github-event': 'pull_request', 'x-github-delivery': 'defaults' }), object(payload));
  assert.equal((await sync.handle(event)).status, 'queued');
  while (await sync.tick(Date.now() + 1000)) { /* drain */ }
  assert.deepEqual(world.pushes, [{ sha: A, ref: 'refs/heads/github-pr/120' }]);
  assert.equal(world.pulls.size, 1);
  const [first] = (await sync.snapshot()).records as SyncRecord[];
  assert.equal(first.status, 'success'); assert.equal(first.mr_url, 'https://gitcode.test/openJiuwen/sciencediscovery/merge_requests/11');
});

test('no GITCODE_TOKEN: sync stays disabled, startup validation passes, the listener shows why', () => {
  for (const extra of [{}, { SDBOT_GITCODE_SYNC_TARGET: TARGET, SDBOT_GITCODE_USERNAME: 'someone' }, { GITCODE_TOKEN: '  ' }] as Environment[]) {
    const cfg = configFromEnv({ ...appEnv, ...extra });
    assert.equal(cfg.gitcode_sync.enabled, false); assert.deepEqual(cfg.gitcode_sync.disabled_reasons, ['no_token']);
    assert.deepEqual(validateConfig(cfg), [], 'a Worker without the token keeps starting');
    assert.deepEqual(publicConfig(cfg).gitcode_sync, { enabled: false, reason: 'no_token', reasons: ['no_token'] });
  }
  // No token wins over missing credentials: the reason stays no_token, unchanged.
  assert.deepEqual(configFromEnv({ SDBOT_REPOS: SOURCE }).gitcode_sync.disabled_reasons, ['no_token']);
  // Even a bare environment (no App, no secret) is valid while sync is off.
  assert.deepEqual(validateConfig(configFromEnv({})), []);
  const listener = syncListener(new Router(undefined, new NoopSync(['no_token'])));
  assert.equal(listener.mode, 'disabled'); assert.equal(listener.description, '未设置 GITCODE_TOKEN，GitCode 同步已停用。');
  assert.deepEqual(listener.routes, ['opened', 'synchronize', 'reopened', 'closed', 'merged'].map(a => `pull_request.${a}`));
  assert.equal(syncListener(new Router()).mode, 'disabled', 'the default router has sync off');
});

test('SDBOT_GITCODE_SYNC_TARGET=off disables sync even with a token; malformed enabled configs are still errors', async t => {
  for (const value of ['off', 'OFF', ' Off ']) {
    const cfg = configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_SYNC_TARGET: value });
    assert.equal(cfg.gitcode_sync.enabled, false); assert.deepEqual(cfg.gitcode_sync.disabled_reasons, ['off']);
    assert.deepEqual(validateConfig(cfg), []);
    assert.deepEqual(publicConfig(cfg).gitcode_sync, { enabled: false, reason: 'off', reasons: ['off'] });
  }
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/gitcode-off-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const off = { ...configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_SYNC_TARGET: 'off' }), data_dir: directory };
  const hub = await NodeGitCodeSync.open(off);
  const listener = syncListener(new Router(undefined, hub));
  assert.equal(listener.mode, 'disabled'); assert.equal(listener.description, 'SDBOT_GITCODE_SYNC_TARGET=off，GitCode 同步已停用。');
  assert.deepEqual(await hub.status(), { enabled: false, reason: 'off', reasons: ['off'] });
  // Malformed sync settings are still configuration errors once sync would run.
  assert.match(validateConfig(configFromEnv(env({ SDBOT_GITCODE_BRANCH_PREFIX: 'main/' }))).join(), /branch prefix/);
  assert.match(validateConfig(configFromEnv(env({ SDBOT_GITCODE_API_URL: 'https://user:pw@gitcode.test/api' }))).join(), /HTTPS without credentials/);
  assert.match(validateConfig(configFromEnv(env({ SDBOT_REPOS: 'other/repo', SDBOT_GITCODE_SYNC_SOURCE: SOURCE }))).join(), /source must be included/);
  const shown = JSON.stringify(publicConfig(configFromEnv(env())));
  assert.ok(!shown.includes(GITCODE_TOKEN) && !shown.includes('sync-bot')); assert.match(shown, /"token_configured":true/);
});

test('missing GitHub credentials only switch sync off, with stable reasons that list every missing item', async t => {
  const cases: [Environment, string[], string][] = [
    [{ SDBOT_GITHUB_WEBHOOK_SECRET: secret }, ['no_github_app'], '缺少 GitHub App 凭据（SDBOT_GITHUB_APP_ID 与 SDBOT_GITHUB_APP_PRIVATE_KEY），GitCode 同步已停用。'],
    // A var-only App ID without its secret key (the production pattern) is missing, not a startup error.
    [{ SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_GITHUB_APP_ID: '42' }, ['no_github_app'], '缺少 GitHub App 凭据（SDBOT_GITHUB_APP_ID 与 SDBOT_GITHUB_APP_PRIVATE_KEY），GitCode 同步已停用。'],
    [{ SDBOT_GITHUB_APP_ID: '42', SDBOT_GITHUB_APP_PRIVATE_KEY: PEM }, ['no_webhook_secret'], '缺少 GitHub Webhook secret（SDBOT_GITHUB_WEBHOOK_SECRET），GitCode 同步已停用。'],
    [{}, ['no_github_app', 'no_webhook_secret'], '缺少 GitHub App 凭据（SDBOT_GITHUB_APP_ID 与 SDBOT_GITHUB_APP_PRIVATE_KEY）；缺少 GitHub Webhook secret（SDBOT_GITHUB_WEBHOOK_SECRET），GitCode 同步已停用。'],
  ];
  await mkdir('.tmp/tests-ts', { recursive: true });
  for (const [extra, reasons, text] of cases) {
    const cfg = configFromEnv({ SDBOT_REPOS: SOURCE, GITCODE_TOKEN, ...extra });
    assert.equal(cfg.gitcode_sync.enabled, false);
    assert.deepEqual(cfg.gitcode_sync.disabled_reasons, reasons);
    assert.deepEqual(validateConfig(cfg), [], 'missing credentials never stop startup');
    assert.deepEqual(publicConfig(cfg).gitcode_sync, { enabled: false, reason: reasons.join(','), reasons });
    const directory = await mkdtemp(resolve('.tmp/tests-ts/gitcode-degrade-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const hub = await NodeGitCodeSync.open({ ...cfg, data_dir: directory });
    const router = new Router(undefined, hub);
    assert.equal(syncListener(router).mode, 'disabled'); assert.equal(syncListener(router).description, text);
    assert.deepEqual(await hub.snapshot(), { ok: true, enabled: false, reason: reasons.join(','), reasons, records: [], pulls: [] });
    const { payload } = await fixture('github_pull_request_opened.json');
    assert.equal((await hub.handle(normalize('github', new Headers({ 'x-github-event': 'pull_request', 'x-github-delivery': 'x' }), object(payload)))).status, 'noop');
  }
  // The webhook secret falls back to SDBOT_WEBHOOK_SECRET, as for ingestion.
  assert.deepEqual(configFromEnv({ ...appEnv, SDBOT_GITHUB_WEBHOOK_SECRET: '', SDBOT_WEBHOOK_SECRET: secret, GITCODE_TOKEN }).gitcode_sync.disabled_reasons, []);
});

test('board publishing without App credentials is reported as disabled instead of failing startup', () => {
  const targets = { SDBOT_BOARD_TARGETS: JSON.stringify({ [SOURCE]: 'ScienceDiscovery/github-status-board' }), SDBOT_BOARD_EXECUTION: 'github_actions' };
  const noApp = configFromEnv({ SDBOT_REPOS: SOURCE, SDBOT_GITHUB_APP_ID: '42', ...targets });
  assert.deepEqual(validateConfig(noApp), []); assert.equal(boardBlocked(noApp), 'no_github_app'); assert.equal(boardBlocked(noApp, true), 'no_github_app');
  // The board collects on its schedule without a webhook secret.
  const noSecret = configFromEnv({ SDBOT_REPOS: SOURCE, SDBOT_GITHUB_APP_ID: '42', SDBOT_GITHUB_APP_PRIVATE_KEY: PEM, ...targets });
  assert.deepEqual(validateConfig(noSecret), []); assert.equal(boardBlocked(noSecret, true), '');
  // Contradictory settings remain errors.
  assert.match(validateConfig(configFromEnv({ ...appEnv, SDBOT_BOARD_GITHUB_TOKEN: 'legacy', ...targets })).join(), /not both/);
  assert.deepEqual(new NoopBoard('no_github_app').status(), { enabled: false, reason: 'no_github_app' });
});

