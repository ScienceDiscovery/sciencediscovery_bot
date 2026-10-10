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
import { evaluateCodeCheck, finishWork, scrub, syncContext, type PullState, type SyncRecord } from '../src/core/gitcode-sync.js';
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
/** GitCode main before the merge, and GitHub main after it (a squash merge: neither is a PR head). */
const MAIN_OLD = 'c'.repeat(40), MAIN_TIP = 'e'.repeat(39) + '3', ZERO = '0'.repeat(40);
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const fixture = async (name: string): Promise<Doc> => JSON.parse(await readFile(resolve('tests-ts/fixtures/gitcode-sync', name), 'utf8')) as Doc;
const comments = await fixture('gitcode_comments.json');
const env = (extra: Environment = {}): Environment => ({ SDBOT_REPOS: SOURCE, SDBOT_GITHUB_WEBHOOK_SECRET: secret, SDBOT_GITCODE_WEBHOOK_SECRET: secret, SDBOT_GITHUB_APP_ID: '42', SDBOT_GITHUB_APP_PRIVATE_KEY: PEM,
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
  /** Every ref update sent to GitCode, with the old SHA it named. */
  readonly updates: { ref: string; old: string; new: string }[] = [];
  readonly deletes: string[] = [];
  readonly branches = new Map<string, string>([['refs/heads/main', MAIN_OLD]]);
  failPush: Error | null = null;
  /** GitHub's view: the default branch tip, and how it relates to GitCode main. */
  mainTip = MAIN_TIP;
  compare = 'ahead';
  /** GitCode refusing a non-fast-forward update of main on its side. */
  rejectMain = false;
  /** GitCode's merge request API keeping the old head after a push, while the git refs move on. */
  freezeApiHead = false;
  /** refs/merge-requests/<n>/head as git sees it, and how often the bot asked. */
  readonly mrRefs = new Map<number, string>();
  mrRefReads = 0;
  /** Body GitCode answers a merge request update with, when it is not the merge request itself. */
  patchResponse: Doc | null = null;
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
      if (method === 'GET' && url.pathname === `/repos/${SOURCE}`) return this.json({ default_branch: 'main' });
      if (method === 'GET' && url.pathname === `/repos/${SOURCE}/branches/main`) return this.json({ name: 'main', commit: { sha: this.mainTip } });
      const compared = /^\/repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(url.pathname);
      if (method === 'GET' && compared) { assert.equal(compared[2], this.mainTip); return this.json({ status: this.compare }); }
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
          if (this.patchResponse) return this.json(this.patchResponse);
        }
        return this.json(this.pullDoc(pull));
      }
    }
    throw new Error(`unexpected outbound request ${method} ${url}`);
  }) as typeof fetch;
  push = async (options: { sha: string; ref: string; source: { authorization: string }; target: { authorization: string }; fastForward?: (old: string) => Promise<boolean> }): Promise<PushResult> => {
    assert.equal(options.target.authorization, basicAuthorization('sync-bot', GITCODE_TOKEN));
    assert.equal(options.source.authorization, basicAuthorization('x-access-token', INSTALLATION_TOKEN));
    if (this.failPush) throw this.failPush;
    const old = this.branches.get(options.ref) || ZERO;
    // Like pushCommit: a branch already at the SHA needs no transfer; fast-forward-only updates check the advertised tip first.
    if (old === options.sha) return { status: 'unchanged', old, new: options.sha, ref: options.ref };
    if (options.fastForward && (old === ZERO || !await options.fastForward(old))) throw new GitTransferError('not_fast_forward', `${options.ref} is at ${old.slice(0, 7)}; only fast-forward updates are allowed`);
    this.updates.push({ ref: options.ref, old, new: options.sha });
    if (this.rejectMain && options.ref === 'refs/heads/main') throw new GitTransferError('not_fast_forward', 'GitCode rejected refs/heads/main: non-fast-forward');
    this.pushes.push({ sha: options.sha, ref: options.ref });
    this.branches.set(options.ref, options.sha);
    for (const pull of this.pulls.values()) if (`refs/heads/${pull.head_ref}` === options.ref) {
      this.mrRefs.set(pull.number, options.sha);
      if (!this.freezeApiHead) pull.head_sha = options.sha;
    }
    return { status: old === options.sha ? 'unchanged' : 'pushed', old, new: options.sha, ref: options.ref };
  };
  deleteRef = async (options: { ref: string; target: { url: string; authorization: string } }) => {
    assert.equal(options.target.authorization, basicAuthorization('sync-bot', GITCODE_TOKEN));
    const old = this.branches.get(options.ref);
    if (!old) return { status: 'absent' as const, old: ZERO, ref: options.ref };
    this.updates.push({ ref: options.ref, old, new: ZERO }); this.deletes.push(options.ref); this.branches.delete(options.ref);
    return { status: 'deleted' as const, old, ref: options.ref };
  };
  mergeRequestHead = async (mr: number): Promise<string | null> => { this.mrRefReads++; return this.mrRefs.get(mr) ?? null; };
  checksFor(sha: string): Check[] { return [...this.checks.values()].filter(c => c.head_sha === sha); }
  /** How often the merge request comments were read: the observable cost of a verdict read. */
  reads(): number { return this.calls.filter(call => call.endsWith('/comments')).length; }
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
  const sync = await NodeGitCodeSync.open(cfg, () => ({ ...syncContext(cfg, world.fetcher, () => clock), push: world.push as never, deleteRef: world.deleteRef as never, mergeRequestHead: world.mergeRequestHead }));
  const archive = await FileArchive.open(directory, cfg.dedupe_window);
  const app = new BotApplication(new Pipeline(cfg, archive, new Router(undefined, sync)), async () => '');
  const send = async (name: string, deliveryId = randomUUID()): Promise<Doc> => {
    const { payload } = await fixture(name);
    const response = await app.webhook((await delivery('pull_request', object(payload), { delivery: deliveryId, path: '/webhook/github' })).request());
    assert.equal(response.status, 200);
    return (await archive.recent(1))[0];
  };
  const listener = (record: Doc, id = 'gitcode_sync.on_pull_request'): string => String(object((record.listeners as Doc[] || []).find(l => object(l).id === id)).status ?? '');
  /** A GitCode webhook delivery (signed unless asked otherwise); returns the HTTP status and the archived record. */
  const gitcode = async (event: 'Note Hook' | 'Merge Request Hook', payload: Doc, options: { unsigned?: boolean } = {}): Promise<{ status: number; record: Doc; woken: string }> => {
    const d = await delivery(event, payload, { provider: 'gitcode', path: '/webhook/gitcode' });
    if (options.unsigned) d.headers.delete('x-gitcode-signature-256');
    const response = await app.webhook(d.request());
    const record = (await archive.recent(1))[0];
    return { status: response.status, record, woken: listener(record, 'gitcode_sync.on_codecheck_event') };
  };
  /** GitHub "Re-run" (check_run) or "Re-run all checks" (check_suite) as the App receives it: fork PRs carry no pull_requests. */
  const rerun = async (kind: 'check_run' | 'check_suite', sha: string, options: { pr?: number; name?: string } = {}): Promise<string> => {
    const payload = kind === 'check_run'
      ? { action: 'rerequested', repository: { full_name: SOURCE }, check_run: { id: 1, name: options.name ?? 'CodeCheck (GitCode)', head_sha: sha, external_id: `gitcode-sync:${options.pr ?? 120}:${sha}`, pull_requests: [] } }
      : { action: 'rerequested', repository: { full_name: SOURCE }, check_suite: { id: 2, head_sha: sha, pull_requests: [] } };
    const response = await app.webhook((await delivery(kind, payload, { path: '/webhook/github' })).request());
    assert.equal(response.status, 200);
    return listener((await archive.recent(1))[0], 'gitcode_sync.on_check_rerun');
  };
  /** Advance the queue clock and drain everything due at that time. */
  const tick = async (ms = 0): Promise<void> => { clock = Math.max(clock, Date.now()) + ms; while (await sync.tick(clock)) { /* drain */ } };
  const records = async (): Promise<SyncRecord[]> => (await sync.snapshot()).records as SyncRecord[];
  return { cfg, world, sync, app, send, gitcode, rerun, listener, tick, records, now: () => clock, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
/** GitCode Note Hook for a comment on merge request `mr` (new and edited notes look the same). */
const note = (mr: number, author = 'openJiuwen-bot', extra: { repo?: string; noteable?: string; branch?: string } = {}): Doc => ({
  object_kind: 'note', event_type: 'note', uuid: randomUUID(), user: { username: author, name: author }, project: { path_with_namespace: extra.repo ?? TARGET },
  object_attributes: { id: 1, note: 'comment', noteable_type: extra.noteable ?? 'MergeRequest', system: false },
  merge_request: { iid: mr, source_branch: extra.branch ?? 'github-pr/120', target_branch: 'main', state: 'opened', title: 'mirror' } });
/** GitCode Merge Request Hook for an update; `changed` lists the fields in `changes`. */
const mrUpdate = (mr: number, changed: string[] = ['labels']): Doc => ({
  object_kind: 'merge_request', event_type: 'merge_request', uuid: randomUUID(), user: { username: 'openJiuwen-bot', name: 'openJiuwen-bot' }, project: { path_with_namespace: TARGET },
  object_attributes: { iid: mr, action: 'update', state: 'opened', source_branch: 'github-pr/120', target_branch: 'main', title: 'mirror' },
  changes: Object.fromEntries(changed.map(field => [field, { previous: [], current: [] }])) });
/** Longer than the old 120 s polling interval. */
const MINUTES_2 = 121000;

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

test('CodeCheck verdicts are read when GitCode reports activity: no polling, stale labels stay in progress, ci-successful passes, ci-failed fails a newer head', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  await h.tick(MINUTES_2);
  assert.equal(h.world.reads(), 0, 'nothing reads GitCode on a timer after the sync');
  const pull = h.world.pulls.get(11)!;
  // A label left by an earlier run on the same MR is not evidence for this head.
  pull.labels = ['ci-successful'];
  h.world.comment(11, 'passed', h.now() - 3600000);
  assert.equal((await h.gitcode('Note Hook', note(11))).woken, 'woken');
  await h.tick();
  let [check] = h.world.checksFor(A);
  assert.equal(h.world.reads(), 1);
  assert.equal(check.status, 'in_progress'); assert.match(check.summary, /GitCode has no CodeCheck verdict yet/); assert.match(check.summary, /predates this head/);
  await h.tick(5000);
  assert.equal(h.world.reads(), 1, 'a few seconds later nothing reads the comments again');
  pull.labels = ['ci-running']; h.world.comment(11, 'cla', h.now()); h.world.comment(11, 'running', h.now());
  await h.gitcode('Note Hook', note(11)); await h.tick();
  [check] = h.world.checksFor(A);
  assert.equal(check.status, 'in_progress'); assert.match(check.summary, /running on GitCode/);
  pull.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now() + 1000);
  await h.gitcode('Note Hook', note(11)); await h.tick();
  [check] = h.world.checksFor(A);
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'success'); assert.equal(check.title, 'CodeCheck passed on GitCode');
  assert.equal((await h.records())[0].action, 'codecheck'); assert.equal((await h.records())[0].status, 'success');
  assert.equal(h.world.reads(), 3, 'one read per GitCode notification');
  // New head: the MR still carries the old success, which must not leak onto B.
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  assert.deepEqual(h.world.pushes.at(-1), { sha: B, ref: 'refs/heads/github-pr/120' });
  assert.match(pull.title, /\(bbbbbbb\)$/); assert.ok(pull.body.includes(B));
  await h.tick(MINUTES_2);
  let [checkB] = h.world.checksFor(B);
  assert.equal(checkB.status, 'in_progress'); assert.equal(h.world.checksFor(A)[0].conclusion, 'success'); assert.equal(h.world.reads(), 3);
  // The label change itself (Merge Request Hook) is enough to read the verdict.
  pull.labels = ['ci-failed']; h.world.comment(11, 'running', h.now()); h.world.comment(11, 'failed', h.now() + 2000);
  assert.equal((await h.gitcode('Merge Request Hook', mrUpdate(11))).woken, 'woken');
  await h.tick();
  [checkB] = h.world.checksFor(B);
  assert.equal(checkB.status, 'completed'); assert.equal(checkB.conclusion, 'failure'); assert.equal(checkB.title, 'CodeCheck failed on GitCode');
  const latest = (await h.records())[0];
  assert.equal(latest.status, 'error'); assert.equal(latest.error_code, 'codecheck_failed');
});

test('only the CI account\'s note on the synced MR of the target repository, delivered signed, reads the verdict', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  const pull = h.world.pulls.get(11)!;
  pull.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now() + 1000);
  assert.equal((await h.gitcode('Note Hook', note(11, 'alice'))).woken, 'ignored', 'another author');
  assert.equal((await h.gitcode('Note Hook', note(99))).woken, 'no_match', 'another merge request');
  assert.equal((await h.gitcode('Note Hook', note(11, 'openJiuwen-bot', { branch: 'feature/x' }))).woken, 'no_match', 'a merge request from another branch');
  assert.equal((await h.gitcode('Note Hook', note(11, 'openJiuwen-bot', { noteable: 'Issue' }))).woken, 'ignored', 'not a merge request comment');
  assert.equal((await h.gitcode('Merge Request Hook', mrUpdate(11, ['title', 'description']))).woken, 'ignored', 'an edit that leaves the labels alone');
  const other = await h.gitcode('Note Hook', note(11, 'openJiuwen-bot', { repo: 'someone/sciencediscovery' }));
  assert.equal(other.record.status, 'ignored'); assert.match(String(other.record.note), /not the active GitCode sync target/); assert.equal(other.woken, '');
  const unsigned = await h.gitcode('Note Hook', note(11), { unsigned: true });
  assert.equal(unsigned.status, 401); assert.equal(unsigned.woken, '');
  await h.tick();
  assert.equal(h.world.reads(), 0, 'none of these touched the GitCode API');
  assert.equal(h.world.checksFor(A)[0].status, 'in_progress');
  // The real one completes the Check right away, without waiting out any interval.
  const started = h.now();
  assert.equal((await h.gitcode('Note Hook', note(11))).woken, 'woken');
  await h.tick();
  const [check] = h.world.checksFor(A);
  assert.equal(check.conclusion, 'success'); assert.ok(h.now() - started < 1000); assert.equal(h.world.reads(), 1);
  // Once the verdict is written, further notes find nothing waiting.
  assert.equal((await h.gitcode('Note Hook', note(11))).woken, 'no_match');
});

test('a result comment ahead of its label gets one 30-second re-read, then waits for GitCode or the deadline', async t => {
  const h = await setup({ SDBOT_GITCODE_VERDICT_TIMEOUT: '600' }); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  const pull = h.world.pulls.get(11)!;
  h.world.comment(11, 'passed', h.now() + 1000);
  await h.gitcode('Note Hook', note(11)); await h.tick();
  assert.equal(h.world.reads(), 1); assert.match(h.world.checksFor(A)[0].summary, /neither `ci-successful` nor `ci-failed` is set/);
  pull.labels = ['ci-successful'];
  await h.tick(31000);
  assert.equal(h.world.reads(), 2); assert.equal(h.world.checksFor(A)[0].conclusion, 'success', 'the label arrived in time for the re-read');
  // Next head: this time the label does not come within the re-read.
  pull.labels = [];
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  h.world.comment(11, 'passed', h.now() + 1000);
  await h.gitcode('Note Hook', note(11)); await h.tick();
  await h.tick(31000);
  assert.equal(h.world.reads(), 4, 'one re-read');
  await h.tick(31000); await h.tick(MINUTES_2);
  assert.equal(h.world.reads(), 4, 'and no more');
  assert.equal(h.world.checksFor(B)[0].status, 'in_progress');
  await h.tick(600000);
  const [check] = h.world.checksFor(B);
  assert.equal(check.conclusion, 'timed_out', 'a result comment without a label is still no verdict'); assert.equal(h.world.reads(), 5);
});

test('closed closes the MR and deletes the sync branch; merged also fast-forwards GitCode main to GitHub main; the merge endpoint is never called', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  assert.equal(h.world.checksFor(A)[0].conclusion, 'cancelled', 'the replaced head no longer waits');
  await h.send('github_pull_request_closed.json'); await h.tick();
  const pull = h.world.pulls.get(11)!;
  assert.equal(pull.state, 'closed'); assert.match(pull.body, /\*\*Closed on GitHub\*\*/);
  assert.deepEqual(h.world.deletes, ['refs/heads/github-pr/120']); assert.equal(h.world.branches.has('refs/heads/github-pr/120'), false);
  assert.equal(h.world.branches.get('refs/heads/main'), MAIN_OLD, 'closing without merging never touches main');
  assert.ok(!h.world.updates.some(u => u.ref === 'refs/heads/main'));
  let [checkB] = h.world.checksFor(B);
  assert.equal(checkB.conclusion, 'cancelled'); assert.equal(checkB.title, 'Pull request closed on GitHub');
  assert.equal((await h.records())[0].summary, 'GitHub PR 已关闭；已关闭 GitCode MR !11；已删除 GitCode 分支 github-pr/120');
  await h.send('github_pull_request_reopened.json'); await h.tick();
  assert.equal(pull.state, 'open');
  assert.deepEqual(h.world.pushes.at(-1), { sha: B, ref: 'refs/heads/github-pr/120' }, 'the deleted branch is pushed again on reopen');
  const waiting = h.world.checksFor(B).filter(c => c.status === 'in_progress');
  assert.equal(waiting.length, 1, 'a completed check run is not reopened; waiting again uses a new run');
  await h.send('github_pull_request_merged.json'); await h.tick();
  // GitHub main's tip (a squash merge), not the PR head and not merge_commit_sha, goes to GitCode main as a fast-forward.
  assert.deepEqual(h.world.updates.filter(u => u.ref === 'refs/heads/main'), [{ ref: 'refs/heads/main', old: MAIN_OLD, new: MAIN_TIP }]);
  assert.equal(h.world.branches.get('refs/heads/main'), MAIN_TIP);
  assert.equal(pull.state, 'closed');
  assert.match(pull.body, /\*\*Merged on GitHub\*\* as `d{40}`/); assert.match(pull.body, /Closed here without merging/);
  assert.equal(h.world.branches.has('refs/heads/github-pr/120'), false); assert.equal(h.world.deletes.length, 2);
  const merged = (await h.records())[0];
  assert.equal(merged.action, 'merged'); assert.equal(merged.status, 'success');
  assert.equal(merged.summary, `已在 GitHub 合并；已把 GitCode main 快进到 GitHub main 尖端 ${MAIN_TIP.slice(0, 7)}；已关闭 GitCode MR !11（未调用合并接口）；已删除 GitCode 分支 github-pr/120`);
  assert.ok(!h.world.calls.some(call => /\/merge(\/|$)/.test(call)));
  [checkB] = h.world.checksFor(B).filter(c => c.id === waiting[0].id);
  assert.equal(checkB.conclusion, 'cancelled'); assert.equal(checkB.title, 'Pull request merged on GitHub');
  // The same merge delivered again neither pushes main nor deletes again.
  const updates = h.world.updates.length;
  assert.equal(h.listener(await h.send('github_pull_request_merged.json')), 'duplicate');
  await h.tick();
  assert.equal(h.world.updates.length, updates); assert.equal(h.world.deletes.length, 2);
});

test('an MR update answered without a number still closes the MR and deletes the sync branch', async t => {
  for (const [action, response] of [['merged', {}], ['closed', { state: 'closed' }]] as const) {
    const h = await setup(); t.after(h.cleanup);
    await h.send('github_pull_request_opened.json'); await h.tick();
    h.world.patchResponse = response;
    await h.send(`github_pull_request_${action}.json`); await h.tick();
    const [record] = await h.records();
    assert.equal(record.action, action); assert.equal(record.status, 'success', record.summary); assert.doesNotMatch(record.summary, /同步失败/);
    assert.match(record.summary, /已关闭 GitCode MR !11.*；已删除 GitCode 分支 github-pr\/120$/);
    assert.equal(h.world.pulls.get(11)!.state, 'closed'); assert.deepEqual(h.world.deletes, ['refs/heads/github-pr/120']);
    assert.ok(h.world.calls.includes(`GET https://gitcode.test/api/v5/repos/${TARGET}/pulls/11`), 'the closed MR is read back by its number');
    assert.ok(!h.world.calls.some(call => /\/merge(\/|$)/.test(call)));
  }
});

test('a merge that cannot fast-forward GitCode main never sends a zero old SHA; the MR is still closed and the branch deleted', async t => {
  for (const reason of ['github', 'gitcode'] as const) {
    const h = await setup(); t.after(h.cleanup);
    await h.send('github_pull_request_opened.json'); await h.tick();
    // GitCode main holds commits GitHub does not have, or GitCode itself refuses the update.
    if (reason === 'github') h.world.compare = 'diverged'; else h.world.rejectMain = true;
    await h.send('github_pull_request_merged.json'); await h.tick();
    assert.equal(h.world.branches.get('refs/heads/main'), MAIN_OLD, 'main is not updated');
    assert.ok(!h.world.updates.some(u => u.ref === 'refs/heads/main' && u.old === ZERO), 'no force through a zero old SHA');
    assert.equal(h.world.updates.filter(u => u.ref === 'refs/heads/main').length, reason === 'github' ? 0 : 1, 'one attempt, no retry');
    assert.equal(h.world.pulls.get(11)!.state, 'closed'); assert.deepEqual(h.world.deletes, ['refs/heads/github-pr/120']);
    const [record] = await h.records();
    assert.equal(record.status, 'error'); assert.equal(record.error_code, 'not_fast_forward');
    assert.match(record.summary, /^已在 GitHub 合并；GitCode 默认分支未更新（not_fast_forward）；已关闭 GitCode MR !11（未调用合并接口）；已删除 GitCode 分支 github-pr\/120$/);
    const pulls = (await h.sync.snapshot()).pulls as Doc[];
    assert.equal(pulls[0].sync_status, 'merged'); assert.equal(pulls[0].error_code, 'not_fast_forward');
    await h.tick(3600000);
    assert.equal(h.world.updates.filter(u => u.ref === 'refs/heads/main').length, reason === 'github' ? 0 : 1, 'a refused fast-forward is not retried');
  }
});

test('only this pull request\'s own prefixed branch is deleted, never the default branch', async t => {
  for (const branch of ['main', 'feature/120', 'github-pr/7']) {
    const h = await setup(); t.after(h.cleanup);
    await h.send('github_pull_request_opened.json'); await h.tick();
    if (branch === 'main') h.world.branches.set('refs/heads/main', MAIN_OLD);
    const state = (await h.sync.store.get(120))!;
    state.branch = branch; await h.sync.store.put(state);
    await h.send('github_pull_request_closed.json'); await h.tick();
    assert.deepEqual(h.world.deletes, [], `${branch} is not deleted`);
    assert.equal(h.world.branches.get('refs/heads/main'), MAIN_OLD);
    const [record] = await h.records();
    assert.equal(record.status, 'error'); assert.equal(record.error_code, 'unsafe_branch'); assert.match(record.summary, /已关闭 GitCode MR !11；未删除 GitCode 分支/);
  }
});

test('GitHub main is read again when a transient failure retries the merge', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  h.world.failApi = { method: 'PATCH', path: /\/pulls\/11$/, status: 503 };
  await h.send('github_pull_request_merged.json'); await h.tick();
  assert.equal((await h.records())[0].status, 'error'); assert.equal(h.world.branches.get('refs/heads/main'), MAIN_TIP, 'main was already fast-forwarded');
  h.world.failApi = null; h.world.mainTip = 'f'.repeat(39) + '4';
  await h.tick(61000);
  assert.equal(h.world.branches.get('refs/heads/main'), h.world.mainTip, 'the retry uses the tip at that time');
  assert.equal(h.world.pulls.get(11)!.state, 'closed'); assert.deepEqual(h.world.deletes, ['refs/heads/github-pr/120']);
  assert.equal((await h.records())[0].status, 'success');
});

test('duplicate and stale deliveries are idempotent; nothing is pushed or created twice', async t => {
  const h = await setup(); t.after(h.cleanup);
  const id = randomUUID();
  assert.equal(h.listener(await h.send('github_pull_request_opened.json', id)), 'queued');
  const again = await h.send('github_pull_request_opened.json', id);
  assert.equal(again.duplicate, true, 'a platform redelivery of the same delivery id reaches no listener');
  await h.tick();
  assert.equal(h.listener(await h.send('github_pull_request_opened.json')), 'duplicate', 'same action and head under a new delivery id');
  await h.tick(MINUTES_2);
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

test('a force push that leaves GitCode\'s API head behind is confirmed through refs/merge-requests/<n>/head', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  h.world.freezeApiHead = true;
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  const pull = h.world.pulls.get(11)!;
  assert.equal(pull.head_sha, A, 'the merge request API still reports the previous head');
  pull.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now() + 1000);
  // The ref has not moved either: not this head's result.
  h.world.mrRefs.set(11, A);
  await h.gitcode('Note Hook', note(11)); await h.tick();
  let [check] = h.world.checksFor(B);
  assert.equal(check.status, 'in_progress'); assert.match(check.summary, /GitCode merge request head is aaaaaaa, waiting for bbbbbbb/);
  // The ref the pipeline checks out is B: the verdict belongs to this head.
  h.world.mrRefs.set(11, B);
  await h.gitcode('Note Hook', note(11)); await h.tick();
  [check] = h.world.checksFor(B);
  assert.equal(check.conclusion, 'success'); assert.equal(h.world.mrRefReads, 2);
});

test('Re-run on GitHub reads an already synced head again in a new check run, without syncing again', async t => {
  const h = await setup({ SDBOT_GITCODE_VERDICT_TIMEOUT: '600' }); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  await h.tick(601000);
  assert.equal(h.world.checksFor(A)[0].conclusion, 'timed_out');
  // The result was there in time, but the deadline read missed it.
  const pull = h.world.pulls.get(11)!;
  pull.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now());
  const pushes = h.world.pushes.length, reads = h.world.reads();
  assert.equal(await h.rerun('check_run', A), 'rechecking');
  await h.tick();
  const runs = h.world.checksFor(A);
  assert.equal(runs.length, 2, 'a new check run; the timed-out one is not reopened');
  assert.equal(runs[0].conclusion, 'timed_out'); assert.equal(runs[1].conclusion, 'success');
  assert.equal(h.world.pushes.length, pushes, 'nothing is synced again'); assert.equal(h.world.reads(), reads + 1);
  assert.equal((await h.records())[0].action, 'codecheck');
  // "Re-run all checks" arrives as a check suite and is matched by its head SHA.
  assert.equal(await h.rerun('check_suite', A), 'rechecking');
  await h.tick();
  assert.equal(h.world.checksFor(A).length, 3); assert.equal(h.world.checksFor(A)[2].conclusion, 'success');
  // Without a result the re-run waits again, with a fresh deadline.
  pull.labels = []; h.world.comments.set(11, []);
  assert.equal(await h.rerun('check_run', A), 'rechecking');
  await h.tick(); await h.tick(300000);
  assert.equal(h.world.checksFor(A)[3].status, 'in_progress');
  await h.tick(301000);
  assert.equal(h.world.checksFor(A)[3].conclusion, 'timed_out');
  // Other checks, older heads, unknown pull requests: nothing happens.
  const before = h.world.calls.length;
  assert.equal(await h.rerun('check_run', A, { name: 'build' }), 'ignored');
  assert.equal(await h.rerun('check_run', B), 'stale');
  assert.equal(await h.rerun('check_run', A, { pr: 999 }), 'unknown');
  assert.equal(await h.rerun('check_suite', 'f'.repeat(40)), 'unknown');
  await h.tick();
  assert.equal(h.world.calls.length, before);
});

test('Re-run after a failed sync syncs the head again and waits for GitCode', async t => {
  const h = await setup(); t.after(h.cleanup);
  h.world.failPush = new GitTransferError('permission_denied', 'GitCode receive-pack returned HTTP 403: credentials rejected or missing permission', 403);
  await h.send('github_pull_request_opened.json'); await h.tick();
  assert.equal(h.world.checksFor(A)[0].title, 'Sync to GitCode failed'); assert.equal(h.world.pushes.length, 0);
  h.world.failPush = null;
  assert.equal(await h.rerun('check_run', A), 'resyncing');
  await h.tick();
  assert.deepEqual(h.world.pushes, [{ sha: A, ref: 'refs/heads/github-pr/120' }]);
  const runs = h.world.checksFor(A);
  assert.equal(runs.length, 2); assert.equal(runs[1].status, 'in_progress');
  h.world.pulls.get(11)!.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now() + 1000);
  await h.gitcode('Note Hook', note(11)); await h.tick();
  assert.equal(h.world.checksFor(A)[1].conclusion, 'success');
  // A closed pull request is not re-run.
  await h.send('github_pull_request_synchronize.json'); await h.tick();
  await h.send('github_pull_request_closed.json'); await h.tick();
  assert.equal(await h.rerun('check_run', B), 'closed');
});

test('the default 30-minute deadline is one read: no verdict times the Check out, never success', async t => {
  const h = await setup(); t.after(h.cleanup);
  assert.equal(h.cfg.gitcode_sync.verdict_timeout_seconds, 1800);
  await h.send('github_pull_request_opened.json'); await h.tick();
  h.world.pulls.get(11)!.labels = ['ci-successful'];
  assert.match(h.world.checksFor(A)[0].summary, /Verdict deadline/);
  await h.tick(1800000 - 5000);
  assert.equal(h.world.reads(), 0, 'nothing is read before the deadline without a GitCode notification');
  await h.tick(6000);
  const [check] = h.world.checksFor(A);
  assert.equal(h.world.reads(), 1);
  assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'timed_out'); assert.equal(check.title, 'No CodeCheck verdict from GitCode');
  assert.match(check.summary, /within 30 minutes of the sync/);
  const [record] = await h.records();
  assert.equal(record.error_code, 'codecheck_timeout'); assert.equal(record.summary, '超过 30 分钟仍没有 CodeCheck 结论，GitHub Check 记为超时');
  await h.tick(3600000);
  assert.equal(h.world.reads(), 1, 'a timed-out head is not read again');
});

test('the deadline read still finds a verdict whose GitCode notification was lost', async t => {
  const h = await setup({ SDBOT_GITCODE_VERDICT_TIMEOUT: '600' }); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  h.world.pulls.get(11)!.labels = ['ci-successful']; h.world.comment(11, 'passed', h.now() + 1000);
  await h.tick(601000);
  const [check] = h.world.checksFor(A);
  assert.equal(check.conclusion, 'success'); assert.equal(h.world.reads(), 1);
});

test('GitCode read failures back off a bounded number of times, then leave only the deadline read', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  h.world.failApi = { method: 'GET', path: /\/pulls\/11$/, status: 503 };
  await h.gitcode('Note Hook', note(11)); await h.tick();
  const lookups = () => h.world.calls.filter(call => call.endsWith('/pulls/11')).length;
  const first = lookups();
  for (const wait of [61000, 301000, 901000]) await h.tick(wait);
  assert.equal(lookups(), first + 3, 'three retries');
  assert.match((await h.records())[0].summary, /连续 4 次读取 GitCode CodeCheck 结果失败/);
  await h.tick(MINUTES_2);
  assert.equal(lookups(), first + 3, 'then it stops instead of spinning');
  h.world.failApi = null;
  await h.tick(1800000);
  assert.equal(h.world.checksFor(A)[0].conclusion, 'timed_out');
});

test('states stored while the bot polled are read once and then wait for the new deadline', async t => {
  const h = await setup(); t.after(h.cleanup);
  await h.send('github_pull_request_opened.json'); await h.tick();
  const legacy = async (pushedAgo: number): Promise<PullState> => {
    const state = (await h.sync.store.get(120))!;
    delete state.deadline; delete state.rechecked;
    state.pushed_at = h.now() - pushedAgo; state.poll_due = h.now() - 1000;
    await h.sync.store.put(state); return state;
  };
  // Still inside the 30 minutes: one read, then the next due time is the deadline, not 120 s.
  const inside = await legacy(5 * 60000);
  await h.tick();
  let state = (await h.sync.store.get(120))!;
  assert.equal(h.world.reads(), 1); assert.equal(state.deadline, inside.pushed_at! + 1800000); assert.equal(state.poll_due, state.deadline);
  await h.tick(MINUTES_2);
  assert.equal(h.world.reads(), 1);
  // Past the 30 minutes (like GitHub #241 / GitCode !173): the first wake-up times it out.
  await legacy(40 * 60000);
  await h.tick();
  state = (await h.sync.store.get(120))!;
  assert.equal(h.world.checksFor(A)[0].conclusion, 'timed_out'); assert.equal(state.poll_due, null); assert.equal(h.world.reads(), 2);
});

test('a GitCode notification that arrives while a read is running is kept, not overwritten by the read', () => {
  const base = { poll_due: 1000, lease: 0, generation: 1, done: 1, attempts: 0, next_try: 0 } as unknown as PullState;
  const latest = { ...base, poll_due: 1500, lease: 9999 } as PullState, after = { ...base, poll_due: 1800000 } as PullState;
  assert.equal(finishWork(latest, base, after).poll_due, 1500);
  assert.equal(finishWork({ ...base, lease: 9999 } as PullState, base, after).poll_due, 1800000, 'no notification: the job decides');
  assert.equal(finishWork(latest, base, { ...base, poll_due: null } as PullState).poll_due, null, 'a written verdict ends the wait');
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
  assert.equal(cfg.gitcode_sync.verdict_timeout_seconds, 1800);
  assert.equal(object(publicConfig(cfg).gitcode_sync).poll_seconds, undefined, 'there is no polling interval to publish');
  // An old polling interval left in the environment is ignored instead of failing startup; the timeout floor stays.
  assert.deepEqual(validateConfig(configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_POLL_SECONDS: '5' })), []);
  assert.match(validateConfig(configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_VERDICT_TIMEOUT: '599' })).join(), /verdict timeout must be >=600s/);
  assert.deepEqual(validateConfig(configFromEnv({ ...appEnv, GITCODE_TOKEN, SDBOT_GITCODE_VERDICT_TIMEOUT: '600' })), []);
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
  const verdicts = new Router(undefined, sync).bus.inventory().find(l => l.id === 'gitcode_sync.on_codecheck_event')!;
  assert.equal(verdicts.mode, 'active'); assert.deepEqual(verdicts.providers, ['gitcode']); assert.deepEqual(verdicts.repositories, ['openjiuwen/sciencediscovery']);
  assert.deepEqual(verdicts.routes, ['issue_comment.created', 'pull_request.edited']);
  const reruns = new Router(undefined, sync).bus.inventory().find(l => l.id === 'gitcode_sync.on_check_rerun')!;
  assert.equal(reruns.mode, 'active'); assert.deepEqual(reruns.providers, ['github']); assert.deepEqual(reruns.routes, ['check_run.rerequested', 'check_suite.rerequested']);
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
  const verdicts = new Router(undefined, new NoopSync(['no_token'])).bus.inventory().find(l => l.id === 'gitcode_sync.on_codecheck_event')!;
  assert.equal(verdicts.mode, 'disabled'); assert.equal(verdicts.description, '未设置 GITCODE_TOKEN，GitCode 同步已停用。');
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

