/// <reference types="@cloudflare/workers-types" />
import { ACTIONS_RULE_LIMIT, actionsCatalog, parseActionsRule, type ActionsRule } from '../core/actions-rules.js';
import { collectionPermissions, type RepositoryIdentity } from '../core/github-app.js';
import { normalizePermissions, parsePermissions, permissionCatalog, type PermissionSet } from '../core/permissions.js';
import type { AdminReply } from './forward.js';

/** The dashboard collection as it was before rules existed; it becomes the first rule. */
export interface BoardCollection { source: string; destination: string; repository_id: string; owner_id: string }
export const DEFAULT_COLLECTION_PERMISSIONS = Object.freeze({
  source: normalizePermissions(collectionPermissions(false) as Record<string, string>),
  target: normalizePermissions(collectionPermissions(true) as Record<string, string>),
});
const RULE_ID = /^[0-9a-f-]{36}$/;

/**
 * GitHub Actions access rules in the bot's Durable Object, read once per object lifetime.
 * The first read seeds the dashboard collection rule from the Worker's configuration (and the
 * permissions saved by the earlier single Actions entry), once: a deleted rule stays deleted.
 */
export class WorkerActionsRules {
  private cache: ActionsRule[] | null = null;
  constructor(readonly storage: DurableObjectStorage, private readonly board: BoardCollection | null,
    private readonly lookup: (repository: string) => Promise<RepositoryIdentity | null>) {}
  list(): ActionsRule[] {
    if (!this.cache) {
      const sql = this.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS actions_rules (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS actions_rules_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      if (!sql.exec("SELECT 1 FROM actions_rules_state WHERE key = 'seeded'").toArray().length) this.storage.transactionSync(() => this.seed());
      this.cache = sql.exec<{ doc: string }>('SELECT doc FROM actions_rules').toArray().map(row => JSON.parse(row.doc) as ActionsRule)
        .sort((a, b) => a.created.localeCompare(b.created));
    }
    return this.cache;
  }
  private seed(): void {
    const sql = this.storage.sql;
    if (this.board) {
      // Permissions chosen on the earlier single "GitHub Actions" entry carry over.
      sql.exec('CREATE TABLE IF NOT EXISTS token_permissions (id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
      const saved = sql.exec<{ doc: string }>("SELECT doc FROM token_permissions WHERE id = 'actions'").toArray()[0];
      const earlier = saved ? JSON.parse(saved.doc) as { source?: unknown; target?: unknown } : {};
      const chosen = (value: unknown, fallback: PermissionSet) => { const parsed = parsePermissions(value); return parsed.ok ? parsed.value : { ...fallback }; };
      const now = new Date().toISOString();
      const rule: ActionsRule = { id: crypto.randomUUID(), name: '看板采集', repository: this.board.destination, repository_id: this.board.repository_id, owner_id: this.board.owner_id,
        workflow: '.github/workflows/collect.yml', branch: 'main', events: ['schedule', 'workflow_dispatch'],
        grants: [{ purpose: 'source', repository: this.board.source, permissions: chosen(earlier.source, DEFAULT_COLLECTION_PERMISSIONS.source) },
          { purpose: 'target', repository: this.board.destination, permissions: chosen(earlier.target, DEFAULT_COLLECTION_PERMISSIONS.target) }],
        created: now, updated: now };
      sql.exec('INSERT INTO actions_rules VALUES (?, ?)', rule.id, JSON.stringify(rule));
    }
    sql.exec('DROP TABLE IF EXISTS token_permissions');
    sql.exec("INSERT INTO actions_rules_state VALUES ('seeded', ?)", new Date().toISOString());
  }
  private save(rule: ActionsRule): void {
    this.storage.sql.exec('INSERT INTO actions_rules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc', rule.id, JSON.stringify(rule));
  }
  /** Access-authenticated management. The workflow repository's IDs are looked up when it is set or changed. */
  async admin(method: string, id: string | null, input: unknown): Promise<AdminReply> {
    const rules = this.list(), index = id ? rules.findIndex(rule => rule.id === id) : -1;
    if (method === 'GET' && !id) return { status: 200, body: { ok: true, ...actionsCatalog(), permission_catalog: permissionCatalog(), rules } };
    if (id && (!RULE_ID.test(id) || index < 0)) return { status: 404, body: { ok: false, error: 'rule not found' } };
    if (method === 'DELETE' && id) {
      this.storage.sql.exec('DELETE FROM actions_rules WHERE id = ?', id);
      rules.splice(index, 1);
      return { status: 200, body: { ok: true } };
    }
    if (!(method === 'POST' && !id) && !(method === 'PUT' && id)) return { status: 405, body: { ok: false, error: 'method not allowed' } };
    const parsed = parseActionsRule(input);
    if (!parsed.ok) return { status: 422, body: { ok: false, error: parsed.error } };
    if (!id && rules.length >= ACTIONS_RULE_LIMIT) return { status: 422, body: { ok: false, error: `at most ${ACTIONS_RULE_LIMIT} rules` } };
    const previous = id ? rules[index] : null;
    let identity = previous && previous.repository.toLowerCase() === parsed.value.repository.toLowerCase()
      ? { full_name: previous.repository, id: previous.repository_id, owner_id: previous.owner_id } : null;
    identity ||= await this.lookup(parsed.value.repository);
    if (!identity) return { status: 422, body: { ok: false, error: `cannot read ${parsed.value.repository} on GitHub to pin its IDs; check the name, or install the GitHub App there if it is private` } };
    const now = new Date().toISOString();
    const rule: ActionsRule = { ...parsed.value, repository: identity.full_name, repository_id: identity.id, owner_id: identity.owner_id,
      id: previous?.id || crypto.randomUUID(), created: previous?.created || now, updated: now };
    this.save(rule);
    if (previous) rules[index] = rule; else rules.push(rule);
    return { status: previous ? 200 : 201, body: { ok: true, rule } };
  }
}
