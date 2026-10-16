/// <reference types="@cloudflare/workers-types" />
import { collectionPermissions } from '../core/github-app.js';
import { normalizePermissions, parsePermissions, permissionCatalog, type PermissionSet } from '../core/permissions.js';
import { object } from '../core/types.js';
import type { AdminReply } from './forward.js';

/** The two tokens the dashboard's collect.yml exchanges: `source` reads the source repository, `target` writes the dashboard. */
export interface ActionsPermissions { source: PermissionSet; target: PermissionSet }
export const ACTIONS_PURPOSES = ['source', 'target'] as const;
/** What collection has always needed; also what is used until the admin page saves something else. */
export const DEFAULT_ACTIONS_PERMISSIONS: ActionsPermissions = Object.freeze({
  source: normalizePermissions(collectionPermissions(false) as Record<string, string>),
  target: normalizePermissions(collectionPermissions(true) as Record<string, string>),
});

/**
 * The Actions exchange's permissions, one row in the bot's Durable Object. The row is read once per
 * object lifetime; until an administrator saves a choice the defaults apply.
 */
export class WorkerActionsPermissions {
  private cache: (ActionsPermissions & { updated: string | null }) | null = null;
  constructor(readonly storage: DurableObjectStorage) {}
  current(): ActionsPermissions & { updated: string | null } {
    if (!this.cache) {
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS token_permissions (id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
      const row = this.storage.sql.exec<{ doc: string }>("SELECT doc FROM token_permissions WHERE id = 'actions'").toArray()[0];
      this.cache = row ? JSON.parse(row.doc) : { ...DEFAULT_ACTIONS_PERMISSIONS, updated: null };
    }
    return this.cache!;
  }
  /** Access-authenticated: GET shows the choice with the catalog and defaults, PUT replaces both sets. */
  admin(method: string, input: unknown): AdminReply {
    if (method === 'GET') {
      const current = this.current();
      return { status: 200, body: { ok: true, permission_catalog: permissionCatalog(), defaults: DEFAULT_ACTIONS_PERMISSIONS,
        source: current.source, target: current.target, updated: current.updated } };
    }
    if (method !== 'PUT') return { status: 405, body: { ok: false, error: 'method not allowed' } };
    const doc = object(input), next: Partial<ActionsPermissions> = {};
    for (const purpose of ACTIONS_PURPOSES) {
      const parsed = parsePermissions(doc[purpose]);
      if (!parsed.ok) return { status: 422, body: { ok: false, error: `${purpose}: ${parsed.error}` } };
      next[purpose] = parsed.value;
    }
    const saved = { source: next.source!, target: next.target!, updated: new Date().toISOString() };
    this.current();
    this.storage.sql.exec("INSERT INTO token_permissions VALUES ('actions', ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc", JSON.stringify(saved));
    this.cache = saved;
    return { status: 200, body: { ok: true, source: saved.source, target: saved.target, updated: saved.updated } };
  }
}
