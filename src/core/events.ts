import { array, nullable as n, number, object as o, string as s, type BotEvent, type Doc } from './types.js';

export const QUALITY_KINDS = ['workflow_run', 'workflow_job', 'check_run', 'check_suite', 'status', 'release', 'create', 'delete'];
const githubKinds: Record<string, string> = { ping: 'ping', issues: 'issue', issue_comment: 'issue_comment', pull_request: 'pull_request',
  pull_request_review: 'pull_request_review', pull_request_review_comment: 'pull_request_review', push: 'push', installation: 'installation', installation_repositories: 'installation',
  ...Object.fromEntries(QUALITY_KINDS.map(v => [v, v])) };
const gitcodeKinds: Record<string, string> = { 'Issue Hook': 'issue', 'Merge Request Hook': 'pull_request', 'Note Hook': 'issue_comment', 'Push Hook': 'push', 'Tag Push Hook': 'push' };
const gitcodeObjects: Record<string, string> = { issue: 'issue', merge_request: 'pull_request', note: 'issue_comment', push: 'push', tag_push: 'push' };
const actions: Record<string, string> = { open: 'opened', close: 'closed', reopen: 'reopened', update: 'edited', merge: 'merged' };
const lookup = (mapping: Record<string, string>, key: string): string => Object.hasOwn(mapping, key) ? mapping[key] : '';
const login = (value: unknown): string => s(o(value).login);
const user = (value: unknown): string => s(o(value).username) || s(o(value).name);

function base(provider: string, headers: Headers, payload: Doc): BotEvent {
  const raw = headers.get(`x-${provider}-event`) || '';
  return { provider, delivery_id: headers.get(`x-${provider}-delivery`) || '', kind: 'unknown', action: '', repo: '', number: null,
    title: '', url: '', sender: '', merged: false, labels: [], ref: '', raw_event: raw, raw_action: '', extra: {}, payload };
}
function fillItem(event: BotEvent, value: unknown): void {
  const item = o(value);
  event.number = number(item.number); event.title = s(item.title); event.url = s(item.html_url);
  event.labels = array(item.labels).map(l => s(o(l).name)).filter(Boolean);
  Object.assign(event.extra, { state: n(item.state), author: login(item.user), assignees: array(item.assignees).map(login).filter(Boolean) });
}
function github(headers: Headers, p: Doc): BotEvent {
  const e = base('github', headers, p), x = e.extra;
  e.kind = lookup(githubKinds, e.raw_event) || 'unknown'; e.raw_action = e.action = s(p.action);
  e.repo = s(o(p.repository).full_name); e.sender = login(p.sender);
  const target = headers.get('x-github-hook-installation-target-type');
  if (target) x.hook_target = `${target}:${headers.get('x-github-hook-installation-target-id') || ''}`;
  if (p.installation) x.installation_id = n(o(p.installation).id);
  switch (e.kind) {
    case 'ping': {
      const hook = o(p.hook); e.action = 'ping';
      Object.assign(x, { zen: n(p.zen), hook_id: n(p.hook_id), hook_type: n(hook.type), hook_events: n(hook.events) }); break;
    }
    case 'issue':
      fillItem(e, p.issue);
      if (p.label) x.label = n(o(p.label).name);
      if (p.assignee) x.assignee = login(p.assignee);
      break;
    case 'issue_comment': {
      fillItem(e, p.issue); const comment = o(p.comment);
      Object.assign(x, { on: o(p.issue).pull_request ? 'pull_request' : 'issue', comment_id: n(comment.id), comment_url: n(comment.html_url), comment_author: login(comment.user) }); break;
    }
    case 'pull_request': {
      const pr = o(p.pull_request); fillItem(e, pr);
      Object.assign(x, { draft: !!pr.draft, head: n(o(pr.head).ref), head_sha: n(o(pr.head).sha), base: n(o(pr.base).ref), merged_at: n(pr.merged_at), merge_commit_sha: n(pr.merge_commit_sha), merged_by: login(pr.merged_by) });
      e.merged = !!pr.merged || !!pr.merged_at;
      if (e.raw_action === 'closed' && e.merged) e.action = 'merged';
      if (p.label) x.label = n(o(p.label).name);
      if (e.raw_action === 'synchronize') Object.assign(x, { before: n(p.before), after: n(p.after) });
      break;
    }
    case 'pull_request_review': {
      fillItem(e, p.pull_request); const review = o(p.review || p.comment);
      Object.assign(x, { on: e.raw_event === 'pull_request_review_comment' ? 'diff_comment' : 'review', review_id: n(review.id), review_state: n(review.state), review_url: n(review.html_url), review_author: login(review.user) }); break;
    }
    case 'push':
      e.action = 'pushed'; e.ref = s(p.ref);
      Object.assign(x, { before: n(p.before), after: n(p.after), commits: array(p.commits).length, forced: !!p.forced, created: !!p.created, deleted: !!p.deleted, pusher: n(o(p.pusher).name) }); break;
    case 'installation': {
      const inst = o(p.installation);
      Object.assign(x, { account: login(inst.account), app_id: n(inst.app_id), repositories: array(p.repositories || p.repositories_added).map(r => n(o(r).full_name)), repositories_removed: array(p.repositories_removed).map(r => n(o(r).full_name)) }); break;
    }
  }
  return e;
}
function gitcode(headers: Headers, p: Doc): BotEvent {
  const e = base('gitcode', headers, p), a = o(p.object_attributes), x = e.extra;
  e.kind = lookup(gitcodeKinds, e.raw_event) || lookup(gitcodeObjects, s(p.object_kind)) || 'unknown';
  e.delivery_id ||= s(p.uuid) || s(p.produce_random_id); e.raw_event ||= s(p.object_kind);
  e.raw_action = s(a.action); e.action = lookup(actions, e.raw_action) || e.raw_action;
  e.repo = s(o(p.project).path_with_namespace); e.sender = user(p.user) || s(p.user_username); x.uuid = n(p.uuid);
  if (Object.keys(o(p.changes)).length) x.changed_fields = Object.keys(o(p.changes)).sort();
  if (e.kind === 'issue' || e.kind === 'pull_request') {
    e.number = number(a.iid); e.title = s(a.title); e.url = s(a.url);
    e.labels = array(p.labels).map(l => typeof l === 'string' ? l : s(o(l).title) || s(o(l).name)).filter(Boolean);
    Object.assign(x, { state: n(a.state), author: user(a.author) });
    if (e.kind === 'issue') Object.assign(x, { assignee_ids: array(a.assignee_ids), confidential: !!a.confidential });
    else {
      Object.assign(x, { head: n(a.source_branch), base: n(a.target_branch), head_sha: n(o(a.last_commit).id), merge_status: n(a.merge_status), draft: !!a.work_in_progress,
        source_project_id: n(a.source_project_id), target_project_id: n(a.target_project_id), reviewers: array(a.reviewer_list).filter(v => v && typeof v === 'object').map(user), assignees: array(a.assignee_list).filter(v => v && typeof v === 'object').map(user) });
      if (e.raw_action === 'update' && a.oldrev) { e.action = 'synchronize'; x.before = a.oldrev; }
      e.merged = e.raw_action === 'merge' || a.state === 'merged'; if (e.merged) e.action = 'merged';
    }
  } else if (e.kind === 'issue_comment') {
    const noteable = s(a.noteable_type), on = noteable === 'MergeRequest' ? 'pull_request' : noteable === 'Issue' ? 'issue' : noteable.toLowerCase() || 'unknown';
    const item = o(on === 'pull_request' ? p.merge_request : on === 'issue' ? p.issue : p.commit);
    e.action = 'created'; e.number = number(item.iid); e.title = s(item.title); e.url = s(item.url);
    Object.assign(x, { on, comment_id: n(a.id), comment_url: n(a.url), comment_author: e.sender, system: !!a.system, state: n(item.state), commit_id: on === 'commit' ? n(item.id) : null });
  } else if (e.kind === 'push') {
    e.action = 'pushed'; e.ref = s(p.ref);
    Object.assign(x, { before: n(p.before), after: n(p.after), commits: array(p.commits).length, total_commits: n(p.total_commits_count), branch: n(p.git_branch), tag: e.raw_event === 'Tag Push Hook' || p.object_kind === 'tag_push' });
  }
  return e;
}
export function normalize(provider: string, headers: Headers, payload: Doc): BotEvent {
  if (provider === 'github') return github(headers, payload);
  if (provider === 'gitcode') return gitcode(headers, payload);
  throw new TypeError('unknown provider');
}
