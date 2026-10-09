/// <reference types="@cloudflare/workers-types" />
import type { Doc } from '../core/types.js';

/** Issued installation tokens are listed for 60 days, at most 1000 of them. */
export const GRANT_RETENTION_DAYS = 60;
export const GRANT_LIMIT = 1000;
/** The admin page shows the newest entries. */
export const GRANT_PAGE = 200;

export interface TokenGrant {
  issued_at: string; expires_at: string; source: 'caller' | 'actions'; identity: string; repository: string;
  /** Actions only: `source` or `target`. */
  purpose: string | null;
  /** The permissions the installation token was requested with, e.g. `issues:write`. */
  permissions: string;
}
export const describePermissions = (permissions: Doc): string => Object.entries(permissions).map(([name, level]) => `${name}:${level}`).join(', ');

/**
 * One table for certificate and Actions exchanges. Only these descriptive fields are stored:
 * the token string never reaches storage, the admin API or logs. Webhooks never touch it.
 */
export class WorkerTokenGrants {
  private ready = false;
  constructor(readonly storage: DurableObjectStorage) {}
  private get sql(): SqlStorage {
    if (!this.ready) {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS token_grants (seq INTEGER PRIMARY KEY AUTOINCREMENT, issued INTEGER NOT NULL, doc TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS token_grants_issued ON token_grants(issued);`);
      this.ready = true;
    }
    return this.storage.sql;
  }
  record(grant: TokenGrant, now = Date.now()): void {
    const issued = Date.parse(grant.issued_at);
    if (!Number.isFinite(issued)) throw new TypeError('invalid grant time');
    // Rebuild the document field by field so nothing else (such as a token) can be stored by mistake.
    const doc: TokenGrant = { issued_at: new Date(issued).toISOString(), expires_at: String(grant.expires_at).slice(0, 40), source: grant.source === 'actions' ? 'actions' : 'caller',
      identity: String(grant.identity).slice(0, 120), repository: String(grant.repository).slice(0, 200), purpose: grant.purpose ? String(grant.purpose).slice(0, 20) : null,
      permissions: String(grant.permissions).slice(0, 300) };
    const sql = this.sql;
    this.storage.transactionSync(() => {
      sql.exec('INSERT INTO token_grants (issued, doc) VALUES (?, ?)', issued, JSON.stringify(doc));
      this.trim(now);
    });
  }
  /** Drops entries issued more than 60 days ago and all but the newest 1000; the cron calls this too. */
  prune(now = Date.now()): void {
    if (this.sql) this.storage.transactionSync(() => this.trim(now));
  }
  private trim(now: number): void {
    this.sql.exec('DELETE FROM token_grants WHERE issued < ?', now - GRANT_RETENTION_DAYS * 86400000);
    this.sql.exec('DELETE FROM token_grants WHERE seq <= (SELECT MAX(seq) FROM token_grants) - ?', GRANT_LIMIT);
  }
  list(limit = GRANT_PAGE): TokenGrant[] {
    return this.sql.exec<{ doc: string }>('SELECT doc FROM token_grants ORDER BY seq DESC LIMIT ?', limit).toArray().map(row => JSON.parse(row.doc) as TokenGrant);
  }
}
