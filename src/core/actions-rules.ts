import { parsePermissions, type PermissionSet } from './permissions.js';
import { array, object, string, type Doc } from './types.js';

/**
 * GitHub Actions access rules for POST /actions/token. A rule names one workflow — its repository
 * (pinned by immutable IDs), file, branch and the events it may run on — and the tokens that
 * workflow may exchange: each has a purpose name, a target repository and its own permissions.
 * A token with an empty purpose answers any purpose, or none, that no named token of the rule matches.
 */
export const ACTIONS_RULE_LIMIT = 20;
export const ACTIONS_GRANT_LIMIT = 10;
/** `purpose` is empty for the rule's catch-all token. */
export interface ActionsGrant { purpose: string; repository: string; permissions: PermissionSet }
export interface ActionsRule {
  id: string; name: string;
  /** The workflow's repository as GitHub spells it, and its immutable repository and owner IDs. */
  repository: string; repository_id: string; owner_id: string;
  workflow: string; branch: string; events: string[]; grants: ActionsGrant[];
  created: string; updated: string;
}
export type ActionsRuleInput = Omit<ActionsRule, 'id' | 'repository_id' | 'owner_id' | 'created' | 'updated'>;

/**
 * Events a rule may allow. Pull request events, pull_request_target, merge_group and comment
 * triggers are not offered: they run code or input from people without write access.
 */
export const ACTIONS_EVENTS: readonly { key: string; label: string; description: string }[] = Object.freeze([
  { key: 'schedule', label: '定时（schedule）', description: '按工作流里的 cron 定时运行。' },
  { key: 'workflow_dispatch', label: '手动或 API 触发（workflow_dispatch）', description: '在 Actions 页面点 Run workflow，或由 Bot、API 触发；看板采集就靠它。' },
  { key: 'push', label: '推送（push）', description: '有提交推送到所选分支时运行。' },
  { key: 'release', label: '发布（release）', description: '发布 Release 时运行。' },
  { key: 'workflow_run', label: '其他工作流结束后（workflow_run）', description: '另一个工作流运行结束后接着运行。' },
  { key: 'repository_dispatch', label: '外部事件（repository_dispatch）', description: '外部系统通过 API 发送仓库事件时运行。' },
]);
const EVENTS = new Set(ACTIONS_EVENTS.map(event => event.key));
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const BRANCH = /^(?!refs\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
export const PURPOSE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Admin input for a rule; the repository IDs are looked up by the caller and pinned on save. */
export function parseActionsRule(input: unknown): { ok: true; value: ActionsRuleInput } | { ok: false; error: string } {
  const doc = object(input), name = string(doc.name).trim();
  if (!name || name.length > 80) return { ok: false, error: 'name must be 1-80 characters' };
  const repository = string(doc.repository).trim();
  if (!REPO.test(repository)) return { ok: false, error: 'repository must be owner/name' };
  const workflow = string(doc.workflow).trim();
  if (!WORKFLOW.test(workflow)) return { ok: false, error: 'workflow must be a file in .github/workflows/, such as .github/workflows/collect.yml' };
  const branch = string(doc.branch).trim() || 'main';
  if (!BRANCH.test(branch)) return { ok: false, error: 'branch must be a branch name such as main' };
  const events = [...new Set(array(doc.events).map(String))];
  if (!events.length || events.some(event => !EVENTS.has(event))) return { ok: false, error: `events must be one or more of ${[...EVENTS].join(', ')}` };
  const grants: ActionsGrant[] = [];
  const raw = array(doc.grants);
  if (!raw.length || raw.length > ACTIONS_GRANT_LIMIT) return { ok: false, error: `a rule needs 1-${ACTIONS_GRANT_LIMIT} tokens` };
  for (const item of raw) {
    const grant = object(item), purpose = string(grant.purpose).trim(), target = string(grant.repository).trim(), label = purpose || '(any purpose)';
    if (purpose && !PURPOSE.test(purpose)) return { ok: false, error: 'a token purpose must start with a lowercase letter: a-z, 0-9, - or _, at most 32' };
    if (grants.some(g => g.purpose === purpose)) return { ok: false, error: purpose ? `token purpose ${purpose} is used twice` : 'only one token may leave its purpose empty' };
    if (!REPO.test(target)) return { ok: false, error: `token ${label}: repository must be owner/name` };
    const permissions = parsePermissions(grant.permissions);
    if (!permissions.ok) return { ok: false, error: `token ${label}: ${permissions.error}` };
    grants.push({ purpose, repository: target, permissions: permissions.value });
  }
  return { ok: true, value: { name, repository, workflow, branch, events: ACTIONS_EVENTS.map(e => e.key).filter(key => events.includes(key)), grants } };
}

/** The OIDC claims a rule is matched on; all are checked to be strings by the exchange first. */
export interface ActionsClaims {
  repository: string; repository_id: string; repository_owner_id: string; ref: string; ref_type: string;
  workflow_ref: string; job_workflow_ref?: string; event_name: string; sub: string;
}
/**
 * The rule whose identity matches every claim and which grants `purpose`. Identity is the immutable
 * repository and owner IDs; the workflow path is checked against the repository name in the token,
 * so a renamed repository keeps matching while a new repository under the old name never does.
 * A named token wins; otherwise a catch-all token (empty purpose) answers, also when no purpose is given.
 */
export function matchActionsRule(rules: readonly ActionsRule[], claims: ActionsClaims, purpose: string | null): { rule: ActionsRule; grant: ActionsGrant } | { status: 403; error: string } {
  const [owner, name] = claims.repository.split('/');
  const subjects = [`repo:${claims.repository}:ref:${claims.ref}`, `repo:${owner}@${claims.repository_owner_id}/${name}@${claims.repository_id}:ref:${claims.ref}`];
  const matching = rules.filter(rule => rule.repository_id === claims.repository_id && rule.owner_id === claims.repository_owner_id
    && claims.ref_type === 'branch' && claims.ref === `refs/heads/${rule.branch}` && claims.workflow_ref === `${claims.repository}/${rule.workflow}@${claims.ref}`
    // A direct job may name its own workflow file; anything else is a reusable workflow from elsewhere.
    && (claims.job_workflow_ref === undefined || claims.job_workflow_ref === claims.workflow_ref)
    && rule.events.includes(claims.event_name) && subjects.includes(claims.sub));
  if (!matching.length) return { status: 403, error: 'forbidden' };
  for (const wanted of [purpose, ''].filter(value => value !== null)) {
    for (const rule of matching) {
      const grant = rule.grants.find(g => g.purpose === wanted);
      if (grant) return { rule, grant };
    }
  }
  return { status: 403, error: 'purpose not allowed for this workflow' };
}

/** What the admin page shows for each rule, besides the rule itself. */
export const actionsCatalog = (): Doc => ({ events: ACTIONS_EVENTS.map(event => ({ ...event })), limit: ACTIONS_RULE_LIMIT, grant_limit: ACTIONS_GRANT_LIMIT });
