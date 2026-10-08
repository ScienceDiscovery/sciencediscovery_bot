/**
 * GitHub pull request → GitCode merge request sync and CodeCheck read-back.
 *
 * The listener only stages the latest desired state per pull request; slow work
 * (git transfer, GitCode REST, GitHub checks) runs later from the runtime's own
 * durable queue. Each unit of work is a pure function of one stored state plus
 * network clients, so Node and Workers share the logic and only differ in storage.
 */
import type { Config, GitCodeSyncConfig } from './config.js';
import { publicSyncConfig } from './config.js';
import { GitCodeApi, GitCodeApiError, type GitCodeComment, type GitCodePull } from './gitcode-api.js';
import { GitTransferError, basicAuthorization, pushCommit, type PushResult } from './git-http.js';
import { GitHubApp, GitHubAppAuthError } from './github-app.js';
import { GitHubCheckError, upsertCheck, type CheckConclusion } from './github-checks.js';
import { scrub } from './redact.js';
import { id, number, object, string, type BotEvent, type Doc, type PullRequestSync, type SyncDisabledReason } from './types.js';

export const SYNC_ACTIONS = ['opened', 'synchronize', 'reopened', 'closed', 'merged'] as const;
export type SyncAction = typeof SYNC_ACTIONS[number];
export type CheckState = 'pending' | 'success' | 'failure' | 'timed_out' | 'cancelled';
export type SyncStatus = 'pending' | 'retrying' | 'synced' | 'diverged' | 'failed' | 'closed' | 'merged' | 'skipped';
export interface CheckRef { id: number | null; sha: string; state: CheckState; key: string }
export interface PullState {
  pr: number; url: string; title: string; author: string; base: string;
  head_sha: string; head_ref: string; head_repo: string; commits: number | null; merge_sha: string | null;
  updated: number; action: SyncAction; generation: number; delivery: string; received_at: number;
  done: number; attempts: number; next_try: number; lease: number;
  branch: string; mr: { number: number; url: string } | null; pushed_sha: string | null; pushed_at: number | null;
  sync_status: SyncStatus; error_code: string | null; error: string | null; diverged: { gitcode: number; github: number } | null;
  check: CheckRef | null; poll_due: number | null; poll_errors: number;
}
export interface SyncRecord {
  id: string; time: string; pr: number; pr_url: string; title: string; action: SyncAction | 'codecheck';
  head_sha: string; mr: number | null; mr_url: string | null; status: 'success' | 'error' | 'skipped';
  summary: string; error_code: string | null; error: string | null;
}
export type Decision = 'queued' | 'duplicate' | 'stale' | 'ignored';
const SHA = /^[0-9a-f]{40}$/;
const WORK_FIELDS = ['done', 'attempts', 'next_try', 'branch', 'mr', 'pushed_sha', 'pushed_at', 'sync_status', 'error_code', 'error', 'diverged', 'check', 'poll_due', 'poll_errors'] as const;
export const LEASE_MS = 10 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const short = (sha: string): string => sha.slice(0, 7);

export { scrub };

/** Merge request title and body name the GitHub pull request and its exact head SHA. */
export function mrTitle(state: PullState): string {
  return `[GitHub #${state.pr}] ${state.title.replace(/\s+/g, ' ').trim()}`.slice(0, 230) + ` (${short(state.head_sha)})`;
}
export function mrBody(state: PullState, cfg: GitCodeSyncConfig, final: 'closed' | 'merged' | null = null, at = Date.now()): string {
  const lines = [
    `Mirror of ${state.url} for the GitCode CodeCheck gate.`, '',
    `- GitHub pull request: ${cfg.source}#${state.pr}`, `- GitHub head SHA: \`${state.head_sha}\``, `- Base branch: \`${state.base}\``,
    ...(state.author ? [`- Author on GitHub: \`${state.author}\``] : []), '',
    'Review and merge on GitHub. Do not merge this merge request on GitCode: the bot closes it when the GitHub pull request is closed or merged.',
  ];
  if (final === 'merged') lines.push('', `**Merged on GitHub**${state.merge_sha ? ` as \`${state.merge_sha}\`` : ''} at ${iso(at)}. Closed here without merging.`);
  if (final === 'closed') lines.push('', `**Closed on GitHub** at ${iso(at)} without merging.`);
  lines.push('', `<!-- sciencediscovery-bot gitcode-sync pr=${state.pr} head=${state.head_sha} -->`);
  return lines.join('\n');
}

/** Stage the latest desired state; returns null state when nothing changes. */
export function stagePull(prev: PullState | null, event: BotEvent, cfg: GitCodeSyncConfig, now: number): { state: PullState | null; decision: Decision; reason: string } {
  const action = event.action as SyncAction;
  if (!(SYNC_ACTIONS as readonly string[]).includes(action) || event.kind !== 'pull_request') return { state: null, decision: 'ignored', reason: 'not a synced pull request action' };
  const pr = object(object(event.payload).pull_request), head = object(pr.head), base = object(pr.base);
  const n = number(pr.number), sha = string(head.sha);
  if (n === null || !SHA.test(sha) || !string(base.ref)) return { state: null, decision: 'ignored', reason: 'incomplete pull request payload' };
  const updated = Date.parse(string(pr.updated_at)) || now;
  if (prev && updated < prev.updated) return { state: null, decision: 'stale', reason: 'older than the staged event' };
  if (prev && prev.action === action && prev.head_sha === sha && prev.sync_status !== 'failed') return { state: null, decision: 'duplicate', reason: 'same action and head already staged' };
  const fresh: PullState = { pr: n, url: '', title: '', author: '', base: '', head_sha: sha, head_ref: '', head_repo: '', commits: null, merge_sha: null,
    updated, action, generation: 0, delivery: '', received_at: now, done: 0, attempts: 0, next_try: now, lease: 0,
    branch: cfg.branch_prefix + n, mr: null, pushed_sha: null, pushed_at: null, sync_status: 'pending', error_code: null, error: null, diverged: null,
    check: null, poll_due: null, poll_errors: 0 };
  const state: PullState = { ...(prev ?? fresh), url: string(pr.html_url) || `https://github.com/${cfg.source}/pull/${n}`, title: string(pr.title).slice(0, 300),
    author: string(object(pr.user).login), base: string(base.ref), head_sha: sha, head_ref: string(head.ref), head_repo: string(object(head.repo).full_name),
    commits: number(pr.commits), merge_sha: SHA.test(string(pr.merge_commit_sha)) ? string(pr.merge_commit_sha) : null, updated, action,
    generation: (prev?.generation ?? 0) + 1, delivery: event.delivery_id, received_at: now, attempts: 0, next_try: now, sync_status: 'pending' };
  return { state, decision: 'queued', reason: '' };
}
export function dueOf(state: PullState): number | null {
  const times: number[] = [];
  if (state.generation > state.done) times.push(state.next_try);
  if (state.poll_due !== null) times.push(state.poll_due);
  if (!times.length) return null;
  return Math.max(Math.min(...times), state.lease);
}
/** Apply finished work to the latest stored state; staging owns the pull request fields. */
export function finishWork(latest: PullState, before: PullState, after: PullState): PullState {
  const merged = { ...latest } as Record<string, unknown>;
  for (const key of WORK_FIELDS) merged[key] = structuredClone(after[key]);
  const result = merged as unknown as PullState;
  result.lease = 0;
  if (latest.generation !== before.generation) { result.attempts = latest.attempts; result.next_try = latest.next_try; }
  return result;
}

export interface CodeCheckVerdict { state: 'pending' | 'success' | 'failure'; reason: string; comment: GitCodeComment | null }
const RUNNING = /pipeline\s*\(\s*pipeline number\s*:?\s*\d+\s*\)\s*is running|流水线[^\n]{0,80}(?:运行中|正在运行)/i;
const RESULT = /流水线[^\n]{0,120}执行(?:成功|失败)|pipeline[^\n]{0,120}\b(?:succeeded|failed)\b/i;
/**
 * Labels are the verdict; a CI result comment newer than our push proves the
 * label belongs to this head and not to a previous run on the same MR.
 */
export function evaluateCodeCheck(input: { labels: string[]; comments: GitCodeComment[]; pushedAt: number; mrHeadSha: string; expectedSha: string; ciBot: string; skewMs?: number }): CodeCheckVerdict {
  if (input.mrHeadSha && input.mrHeadSha !== input.expectedSha) return { state: 'pending', reason: `GitCode merge request head is ${short(input.mrHeadSha)}, waiting for ${short(input.expectedSha)}`, comment: null };
  const since = input.pushedAt - (input.skewMs ?? 30000), bot = input.ciBot.toLowerCase();
  const fresh = input.comments.filter(c => c.author.toLowerCase() === bot && c.created_at >= since).sort((a, b) => a.created_at - b.created_at);
  const lastRunning = Math.max(-Infinity, ...fresh.filter(c => RUNNING.test(c.body)).map(c => c.created_at));
  const result = [...fresh].reverse().find(c => !RUNNING.test(c.body) && RESULT.test(c.body) && c.created_at >= lastRunning) || null;
  const labels = new Set(input.labels);
  if (labels.has('ci-running')) return { state: 'pending', reason: 'CodeCheck is running on GitCode (label `ci-running`)', comment: null };
  if (!result) {
    const stale = ['ci-successful', 'ci-failed'].filter(l => labels.has(l));
    return { state: 'pending', reason: stale.length ? `label \`${stale.join('`, `')}\` predates this head; no CI result comment since the sync` : 'no CI result comment and no `ci-successful` / `ci-failed` label yet', comment: null };
  }
  if (labels.has('ci-failed')) return { state: 'failure', reason: 'GitCode labelled the merge request `ci-failed`', comment: result };
  if (labels.has('ci-successful')) return { state: 'success', reason: 'GitCode labelled the merge request `ci-successful`', comment: result };
  return { state: 'pending', reason: 'a CI result comment exists but neither `ci-successful` nor `ci-failed` is set', comment: result };
}

export interface SyncContext {
  cfg: GitCodeSyncConfig; api: GitCodeApi; fetcher: typeof fetch; now: () => number;
  githubToken: () => Promise<string>;
  push: (options: Parameters<typeof pushCommit>[0]) => Promise<PushResult>;
}
export function syncContext(cfg: Config, fetcher: typeof fetch = (...args) => fetch(...args), now = () => Date.now()): SyncContext {
  const sync = cfg.gitcode_sync, app = new GitHubApp(cfg.github_app_id, cfg.github_app_private_key, fetcher);
  let token: Promise<string> | null = null;
  return { cfg: sync, fetcher, now, push: pushCommit,
    api: new GitCodeApi({ api_url: sync.api_url, web_url: sync.web_url, token: sync.token, auth_mode: sync.auth_mode }, fetcher),
    githubToken: () => (token ??= app.tokenForSync(sync.source)) };
}
interface Failure { code: string; message: string; transient: boolean }
class SyncFailure extends Error { constructor(readonly code: string, message: string, readonly transient = false) { super(message); } }
function classify(error: unknown): Failure {
  if (error instanceof SyncFailure || error instanceof GitTransferError || error instanceof GitCodeApiError) return { code: error.code, message: error.message, transient: error.transient };
  if (error instanceof GitHubAppAuthError) return { code: 'github_app_unavailable', message: 'GitHub App token for the source repository was refused or unavailable; check the installation and its Contents, Pull requests and Checks permissions', transient: true };
  if (error instanceof GitHubCheckError) return { code: 'github_check_failed', message: error.message, transient: true };
  return { code: 'internal_error', message: 'unexpected error while syncing', transient: true };
}
const BACKOFF = [60, 300, 900, 1800, 3600];

/** One unit of work: the pending sync for the newest generation first, otherwise a due CodeCheck poll. */
export async function workPull(input: PullState, ctx: SyncContext): Promise<{ state: PullState; records: SyncRecord[] }> {
  const state = structuredClone(input), records: SyncRecord[] = [], now = ctx.now(), cfg = ctx.cfg;
  const secrets = [cfg.token];
  const record = (action: SyncRecord['action'], status: SyncRecord['status'], summary: string, failure?: { code: string; message: string }): void => {
    records.push({ id: id(), time: iso(ctx.now()), pr: state.pr, pr_url: state.url, title: state.title, action, head_sha: state.head_sha,
      mr: state.mr?.number ?? null, mr_url: state.mr?.url ?? null, status, summary: scrub(summary, secrets),
      error_code: failure?.code ?? null, error: failure ? scrub(failure.message, secrets) : null });
  };
  const check = async (sha: string, write: { state: CheckState; status: 'in_progress' | 'completed'; conclusion?: CheckConclusion; title: string; summary: string }): Promise<boolean> => {
    const key = [write.status, write.conclusion || '', write.title, write.summary].join('\u0000');
    const existing = state.check?.sha === sha ? state.check : null;
    // A completed run is never reopened; waiting again (e.g. after a reopen) starts a new check run.
    const current = existing && (existing.state === 'pending' || write.state !== 'pending') ? existing : null;
    if (current && current.key === key) return true;
    try {
      const checkId = await upsertCheck(cfg.source, await ctx.githubToken(), { id: current?.id ?? null, name: cfg.check_name, head_sha: sha,
        external_id: `gitcode-sync:${state.pr}:${sha}`, details_url: state.mr?.url ?? null, status: write.status, conclusion: write.conclusion,
        title: write.title, summary: scrub(write.summary, secrets, 60000, true) }, ctx.fetcher);
      state.check = { id: checkId, sha, state: write.state, key };
      return true;
    } catch (error) {
      const failure = classify(error);
      record(state.action, 'error', `无法更新 GitHub Check（${write.title}）`, failure);
      if (!current) state.check = { id: null, sha, state: write.state, key: '' };
      return false;
    }
  };
  const mrLink = (): string => state.mr ? `[!${state.mr.number}](${state.mr.url})` : 'the GitCode merge request';
  const divergence = (): string => state.diverged ? `\n\n> **Warning:** the GitCode merge request lists ${state.diverged.gitcode} commits but this pull request has ${state.diverged.github}. GitHub and GitCode histories differ, so the GitCode diff may include commits outside this pull request.` : '';
  const pendingSummary = (reason: string): string => `GitCode has no CodeCheck verdict yet for this head.\n\n| | |\n| --- | --- |\n| GitHub head | \`${state.head_sha}\` |\n| GitCode merge request | ${mrLink()} |\n| Synced at | ${state.pushed_at ? iso(state.pushed_at) : 'not yet'} |\n| Status | ${reason} |${divergence()}`;

  if (state.generation > state.done && state.next_try <= now) {
    const open = state.action === 'opened' || state.action === 'synchronize' || state.action === 'reopened';
    // A newer head replaces the gate on the previous one.
    if (state.check && state.check.sha !== state.head_sha && state.check.state === 'pending') {
      const old = state.check;
      try {
        await upsertCheck(cfg.source, await ctx.githubToken(), { id: old.id, name: cfg.check_name, head_sha: old.sha, external_id: `gitcode-sync:${state.pr}:${old.sha}`,
          details_url: state.mr?.url ?? null, status: 'completed', conclusion: 'cancelled', title: 'Superseded by a newer GitHub head', summary: `Head \`${old.sha}\` was replaced by \`${state.head_sha}\` before GitCode produced a CodeCheck verdict.` }, ctx.fetcher);
      } catch (error) { record(state.action, 'error', '无法关闭旧 head 的 GitHub Check', classify(error)); }
      state.check = { ...old, state: 'cancelled' };
    }
    try {
      if (open) {
        if (!cfg.bases.includes(state.base)) {
          state.done = state.generation; state.sync_status = 'skipped'; state.poll_due = null; state.error_code = null; state.error = null;
          record(state.action, 'skipped', `目标分支 ${state.base} 不在同步范围（${cfg.bases.join(', ')}）`);
          return { state, records };
        }
        const defaultBranch = await ctx.api.defaultBranch(cfg.push_repo);
        if (!defaultBranch || state.branch === defaultBranch || cfg.bases.includes(state.branch)) throw new SyncFailure('unsafe_branch', `refusing to push ${state.branch}: GitCode default branch is ${defaultBranch || 'unknown'}`);
        if (!await ctx.api.branchExists(cfg.target, state.base)) throw new SyncFailure('base_missing', `GitCode ${cfg.target} has no branch ${state.base}`);
        let haves: string[] = [];
        try { haves = await ctx.api.branchCommits(cfg.push_repo, state.base, 100); } catch { /* only an optimisation */ }
        const token = await ctx.githubToken();
        const pushed = await ctx.push({ sha: state.head_sha, ref: `refs/heads/${state.branch}`, haves, fetcher: ctx.fetcher,
          source: { url: `${cfg.github_web_url.replace(/\/+$/, '')}/${cfg.source}.git`, authorization: basicAuthorization('x-access-token', token) },
          target: { url: `${cfg.web_url.replace(/\/+$/, '')}/${cfg.push_repo}.git`, authorization: basicAuthorization(cfg.username, cfg.token) } });
        if (pushed.status === 'pushed' || state.pushed_sha !== state.head_sha || state.action === 'reopened') { state.pushed_sha = state.head_sha; state.pushed_at = ctx.now(); }
        let pull: GitCodePull | null = null;
        if (state.mr) { try { pull = await ctx.api.getPull(cfg.target, state.mr.number); } catch (error) { if (!(error instanceof GitCodeApiError && error.status === 404)) throw error; } }
        pull ??= await ctx.api.findPull(cfg.target, state.branch, cfg.push_repo);
        const title = mrTitle(state), body = mrBody(state, cfg);
        if (!pull) {
          const head = cfg.push_repo.toLowerCase() === cfg.target.toLowerCase() ? state.branch : `${cfg.push_repo.split('/')[0]}:${state.branch}`;
          pull = await ctx.api.createPull(cfg.target, { title, head, base: state.base, body });
        } else {
          if (pull.state === 'merged') throw new SyncFailure('mr_merged_on_gitcode', `GitCode merge request !${pull.number} was merged on GitCode; the bot never merges and will not reuse it`);
          const fields: { title?: string; body?: string; state?: 'open' } = {};
          if (pull.title !== title) fields.title = title;
          if (pull.body !== body) fields.body = body;
          if (pull.state && !['open', 'opened', 'reopened'].includes(pull.state)) fields.state = 'open';
          if (Object.keys(fields).length) pull = await ctx.api.updatePull(cfg.target, pull.number, fields);
        }
        state.mr = { number: pull.number, url: pull.url };
        state.diverged = null;
        if (state.commits !== null) {
          try { const count = await ctx.api.pullCommitCount(cfg.target, pull.number); if (count > state.commits) state.diverged = { gitcode: count, github: state.commits }; }
          catch { /* the count only adds a warning */ }
        }
        state.done = state.generation; state.attempts = 0; state.poll_errors = 0; state.poll_due = now + cfg.poll_seconds * 1000;
        const verb = state.action === 'opened' ? '创建' : state.action === 'reopened' ? '重新打开' : '更新';
        const what = `${pushed.status === 'pushed' ? `已推送原始 head ${short(state.head_sha)}` : `GitCode 分支已是 ${short(state.head_sha)}`}，已${verb} GitCode MR !${pull.number}`;
        if (state.diverged) {
          state.sync_status = 'diverged'; state.error_code = 'history_diverged';
          state.error = `GitCode MR !${pull.number} lists ${state.diverged.gitcode} commits but GitHub PR #${state.pr} has ${state.diverged.github}; the GitCode diff may include commits outside this PR`;
          record(state.action, 'error', `${what}；两边历史不一致，GitCode diff 可能包含本 PR 以外的提交`, { code: state.error_code, message: state.error });
        } else {
          state.sync_status = 'synced'; state.error_code = null; state.error = null;
          record(state.action, 'success', what);
        }
        await check(state.head_sha, { state: 'pending', status: 'in_progress', title: 'Waiting for CodeCheck on GitCode', summary: pendingSummary('waiting for the GitCode pipeline') });
      } else {
        const merged = state.action === 'merged';
        let pull: GitCodePull | null = null;
        if (state.mr) { try { pull = await ctx.api.getPull(cfg.target, state.mr.number); } catch (error) { if (!(error instanceof GitCodeApiError && error.status === 404)) throw error; } }
        pull ??= await ctx.api.findPull(cfg.target, state.branch, cfg.push_repo);
        if (!pull) {
          record(state.action, 'skipped', merged ? '已在 GitHub 合并；GitCode 上没有对应 MR，无需关闭' : 'GitHub PR 已关闭；GitCode 上没有对应 MR，无需关闭');
        } else {
          state.mr = { number: pull.number, url: pull.url };
          if (['open', 'opened', 'reopened'].includes(pull.state) || !pull.state) {
            // Close only. The GitCode merge endpoint is never called.
            pull = await ctx.api.updatePull(cfg.target, pull.number, { state: 'closed', body: mrBody(state, cfg, merged ? 'merged' : 'closed', now) });
            record(state.action, 'success', merged ? `已在 GitHub 合并；已关闭 GitCode MR !${pull.number}（未调用合并接口）` : `GitHub PR 已关闭；已关闭 GitCode MR !${pull.number}`);
          } else {
            record(state.action, 'success', `${merged ? '已在 GitHub 合并' : 'GitHub PR 已关闭'}；GitCode MR !${pull.number} 已是 ${pull.state} 状态，未再修改`);
          }
        }
        if (state.check?.state === 'pending') {
          const sha = state.check.sha;
          await check(sha, { state: 'cancelled', status: 'completed', conclusion: 'cancelled', title: merged ? 'Pull request merged on GitHub' : 'Pull request closed on GitHub',
            summary: `The pull request was ${merged ? 'merged' : 'closed'} on GitHub before GitCode produced a CodeCheck verdict for \`${sha}\`. ${mrLink()} was closed without merging.` });
        }
        state.done = state.generation; state.attempts = 0; state.poll_due = null; state.sync_status = merged ? 'merged' : 'closed'; state.error_code = null; state.error = null;
      }
    } catch (error) {
      const failure = classify(error);
      state.attempts += 1;
      const final = !failure.transient || state.attempts >= cfg.max_attempts;
      record(state.action, 'error', `同步失败（第 ${state.attempts} 次${final ? '，已停止重试' : '，稍后重试'}）`, failure);
      state.error_code = failure.code; state.error = scrub(failure.message, secrets);
      if (final) {
        state.done = state.generation; state.sync_status = 'failed'; state.poll_due = null;
        if (open) await check(state.head_sha, { state: 'failure', status: 'completed', conclusion: 'failure', title: 'Sync to GitCode failed',
          summary: `The head \`${state.head_sha}\` could not be synced to GitCode, so CodeCheck cannot run for it.\n\nError (${failure.code}): ${scrub(failure.message, secrets)}\n\nRedeliver the GitHub webhook or push a new commit to retry.` });
      } else {
        state.sync_status = 'retrying'; state.next_try = now + BACKOFF[Math.min(state.attempts - 1, BACKOFF.length - 1)] * 1000;
        if (open) await check(state.head_sha, { state: 'pending', status: 'in_progress', title: 'Retrying sync to GitCode',
          summary: `GitCode has no CodeCheck verdict yet: syncing \`${state.head_sha}\` to GitCode failed (${failure.code}) and will be retried at ${iso(state.next_try)}.` });
      }
    }
    return { state, records };
  }

  if (state.poll_due !== null && state.poll_due <= now) {
    if (!state.mr || !state.check || state.check.state !== 'pending' || state.check.sha !== state.head_sha || !state.pushed_at) { state.poll_due = null; return { state, records }; }
    let verdict: CodeCheckVerdict;
    try {
      const pull = await ctx.api.getPull(cfg.target, state.mr.number);
      verdict = evaluateCodeCheck({ labels: pull.labels, comments: await ctx.api.comments(cfg.target, state.mr.number), pushedAt: state.pushed_at,
        mrHeadSha: pull.head_sha, expectedSha: state.head_sha, ciBot: cfg.ci_bot });
      state.poll_errors = 0;
    } catch (error) {
      const failure = classify(error);
      state.poll_errors += 1;
      if (state.poll_errors === 3) record('codecheck', 'error', '连续 3 次读取 GitCode CodeCheck 结果失败，继续重试', failure);
      verdict = { state: 'pending', reason: `could not read GitCode (${failure.code}); retrying`, comment: null };
    }
    const elapsed = now - state.pushed_at;
    if (verdict.state === 'pending' && elapsed >= cfg.verdict_timeout_seconds * 1000) {
      const hours = Math.round(cfg.verdict_timeout_seconds / 360) / 10;
      const ok = await check(state.head_sha, { state: 'timed_out', status: 'completed', conclusion: 'timed_out', title: 'No CodeCheck verdict from GitCode',
        summary: `GitCode produced no CodeCheck verdict for \`${state.head_sha}\` within ${hours} hours of the sync (${verdict.reason}). Push a new commit or redeliver the webhook to sync again.\n\nGitCode merge request: ${mrLink()}${divergence()}` });
      if (ok) {
        state.poll_due = null;
        record('codecheck', 'error', `超过 ${hours} 小时仍没有 CodeCheck 结论，GitHub Check 记为超时`, { code: 'codecheck_timeout', message: verdict.reason });
      } else state.poll_due = now + cfg.poll_seconds * 1000;
      return { state, records };
    }
    if (verdict.state === 'pending') {
      await check(state.head_sha, { state: 'pending', status: 'in_progress', title: 'Waiting for CodeCheck on GitCode', summary: pendingSummary(verdict.reason) });
      state.poll_due = now + cfg.poll_seconds * 1000 * Math.min(1 + state.poll_errors, 5);
      return { state, records };
    }
    const passed = verdict.state === 'success';
    const evidence = verdict.comment?.url ? `[CI result comment](${verdict.comment.url})` : 'the CI result comment';
    const ok = await check(state.head_sha, { state: verdict.state, status: 'completed', conclusion: passed ? 'success' : 'failure',
      title: passed ? 'CodeCheck passed on GitCode' : 'CodeCheck failed on GitCode',
      summary: `${verdict.reason} for head \`${state.head_sha}\`, confirmed by ${evidence} posted after the sync.\n\nGitCode merge request: ${mrLink()}${passed ? '' : '. Open it for the failing checks.'}${divergence()}` });
    if (ok) {
      state.poll_due = null;
      record('codecheck', passed ? 'success' : 'error', passed ? `CodeCheck 通过（ci-successful），已写 GitHub Check` : `CodeCheck 未通过（ci-failed），已写 GitHub Check`,
        passed ? undefined : { code: 'codecheck_failed', message: 'GitCode labelled the merge request ci-failed' });
    } else state.poll_due = now + cfg.poll_seconds * 1000;
    return { state, records };
  }
  return { state, records };
}

/** Records and current pull states as published to the dashboard; no secrets by construction. */
export function snapshotDoc(cfg: GitCodeSyncConfig, records: SyncRecord[], pulls: PullState[], now = Date.now()): Doc {
  return { ok: true, ...publicSyncConfig(cfg), generated_at: iso(now), records,
    pulls: pulls.map(p => ({ pr: p.pr, pr_url: p.url, title: p.title, base: p.base, head_sha: p.head_sha, action: p.action, branch: p.branch,
      mr: p.mr?.number ?? null, mr_url: p.mr?.url ?? null, sync_status: p.sync_status, check: p.check?.sha === p.head_sha ? p.check.state : null,
      error_code: p.error_code, error: p.error ? scrub(p.error, [cfg.token]) : null, updated_at: iso(p.updated), pending: p.generation > p.done || p.poll_due !== null })) };
}

export interface SyncStore {
  get(pr: number): Promise<PullState | null>;
  put(state: PullState): Promise<void>;
  /** Mark due states as leased and return them, oldest due first. */
  claim(now: number, limit: number): Promise<PullState[]>;
  next(): Promise<number | null>;
  append(records: SyncRecord[]): Promise<void>;
  records(limit: number): Promise<SyncRecord[]>;
  pulls(limit: number): Promise<PullState[]>;
}
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;
/** Claim, work outside the lock, then merge into whatever was staged meanwhile. */
export async function runDue(store: SyncStore, lock: Lock, context: () => SyncContext, now: number, limit = 5): Promise<number> {
  const jobs = await lock(() => store.claim(now, limit));
  if (!jobs.length) return 0;
  const ctx = context();
  for (const job of jobs) {
    let result: { state: PullState; records: SyncRecord[] };
    try { result = await workPull(job, ctx); }
    catch {
      // workPull reports its own failures; reaching here is a defect. Back off instead of spinning.
      result = { state: { ...job, attempts: job.attempts + 1, next_try: now + 300000, poll_due: job.poll_due === null ? null : now + 300000 }, records: [{ id: id(), time: iso(now), pr: job.pr,
        pr_url: job.url, title: job.title, action: job.action, head_sha: job.head_sha, mr: job.mr?.number ?? null, mr_url: job.mr?.url ?? null, status: 'error',
        summary: '同步任务内部错误，5 分钟后重试', error_code: 'internal_error', error: 'unexpected error while syncing' }] };
    }
    await lock(async () => {
      const latest = await store.get(job.pr) ?? job;
      await store.put(finishWork(latest, job, result.state));
      if (result.records.length) await store.append(result.records);
    });
  }
  return jobs.length;
}

/** Listener-facing hub shared by runtimes. */
export abstract class SyncHub implements PullRequestSync {
  readonly mode: 'active' | 'noop';
  readonly source: string;
  readonly disabledReasons: readonly SyncDisabledReason[];
  constructor(readonly config: Config) {
    this.mode = config.gitcode_sync.enabled ? 'active' : 'noop'; this.source = config.gitcode_sync.source.toLowerCase();
    this.disabledReasons = [...config.gitcode_sync.disabled_reasons];
  }
  /** Read and stage in one critical section: finished work must not be overwritten by a stale read. */
  protected abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  protected abstract current(pr: number): Promise<PullState | null>;
  protected abstract stage(state: PullState): Promise<void>;
  async handle(event: BotEvent): Promise<Doc> {
    if (this.mode !== 'active' || event.provider !== 'github' || event.repo.toLowerCase() !== this.source) return { hook: 'gitcode_sync', method: 'on_pull_request', status: this.mode === 'active' ? 'ignored' : 'noop' };
    const pr = number(object(object(event.payload).pull_request).number);
    const decision = await this.transaction(async () => {
      const staged = stagePull(pr === null ? null : await this.current(pr), event, this.config.gitcode_sync, Date.now());
      if (staged.state) await this.stage(staged.state);
      return staged.decision;
    });
    return { hook: 'gitcode_sync', method: 'on_pull_request', status: decision };
  }
  abstract status(): Doc | Promise<Doc>;
  abstract snapshot(limit?: number): Promise<Doc>;
}
