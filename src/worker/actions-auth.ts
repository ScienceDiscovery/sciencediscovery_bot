import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { disabledSync, targets } from '../core/config.js';
import { captureBody, jsonResponse } from '../core/http.js';
import { GitHubApp } from '../core/github-app.js';
import { object } from '../core/types.js';
import { PURPOSE, matchActionsRule, type ActionsClaims, type ActionsRule } from '../core/actions-rules.js';
import { OBJECT_NAME, workerConfig, type WorkerEnv } from './env.js';
import { describePermissions } from './token-grants.js';

const issuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks'), {
  timeoutDuration: 5000,
  [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'manual' }),
});
const fail = (error: string, status: number) => jsonResponse({ ok: false, error }, status);

interface Collector { cfg: ReturnType<typeof workerConfig>; source: string; destination: string; runKey: string; expires: number }
/** The dashboard's collect.yml identity, verified the same way for every /actions endpoint. */
async function verifyCollector(request: Request, env: WorkerEnv, requireApp = true): Promise<Collector | Response> {
  if (request.method !== 'POST') return fail('method not allowed', 405);
  const cfg = workerConfig(env), mappings = Object.entries(targets(cfg));
  const repositoryId = String(env.SDBOT_ACTIONS_REPOSITORY_ID || '');
  const ownerId = String(env.SDBOT_ACTIONS_OWNER_ID || '');
  const audience = String(env.SDBOT_ACTIONS_AUDIENCE || '');
  if (mappings.length !== 1 || !/^[1-9]\d*$/.test(repositoryId) || !/^[1-9]\d*$/.test(ownerId) || !audience ||
      !env.SDBOT_ADMIN_HOSTNAME || (requireApp && (!cfg.github_app_id || !cfg.github_app_private_key))) return fail('exchange unavailable', 503);
  const [source, destination] = mappings[0];
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') || '')?.[1];
  if (new URL(request.url).hostname !== env.SDBOT_ADMIN_HOSTNAME || !token || token.length > 16384) return fail('unauthorized', 401);
  let runKey: string, expires: number;
  try {
    const { payload: p } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nbf', 'jti'], maxTokenAge: '10m', clockTolerance: 5 });
    const [owner, name] = destination.split('/');
    // GitHub also includes job_workflow_ref for direct jobs; if present it must identify this same workflow.
    // Support GitHub's original and immutable subject formats, while always pinning IDs.
    const subjects = [`repo:${destination}:ref:refs/heads/main`, `repo:${owner}@${ownerId}/${name}@${repositoryId}:ref:refs/heads/main`];
    if (p.repository !== destination || p.repository_id !== repositoryId || p.repository_owner_id !== ownerId ||
        p.ref !== 'refs/heads/main' || p.ref_type !== 'branch' ||
        p.workflow_ref !== `${destination}/.github/workflows/collect.yml@refs/heads/main` ||
        (p.job_workflow_ref !== undefined && p.job_workflow_ref !== `${destination}/.github/workflows/collect.yml@refs/heads/main`) || !['schedule', 'workflow_dispatch'].includes(String(p.event_name)) ||
        !subjects.includes(String(p.sub)) || !/^[1-9]\d*$/.test(String(p.run_id)) || !/^[1-9]\d*$/.test(String(p.run_attempt))) {
      return fail('forbidden', 403);
    }
    runKey = `${repositoryId}:${p.run_id}:${p.run_attempt}`;
    expires = p.exp!;
  } catch { return fail('unauthorized', 401); }
  return { cfg, source, destination, runKey, expires };
}

/**
 * POST /actions/token. A GitHub Actions run proves who it is with its OIDC token and receives an
 * installation token for one purpose of the access rule matching that identity; the rules, their
 * target repositories and permissions are kept on the admin page. Credentials only: never a
 * webhook, never archived, and the tokens never reach storage or logs.
 */
export async function exchangeActionsToken(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== 'POST') return fail('method not allowed', 405);
  const cfg = workerConfig(env), audience = String(env.SDBOT_ACTIONS_AUDIENCE || '');
  if (!audience || !env.SDBOT_ADMIN_HOSTNAME || !cfg.github_app_id || !cfg.github_app_private_key) return fail('exchange unavailable', 503);
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') || '')?.[1];
  if (new URL(request.url).hostname !== env.SDBOT_ADMIN_HOSTNAME || !token || token.length > 16384) return fail('unauthorized', 401);
  let claims: ActionsClaims & { run_id: string; run_attempt: string }, expires: number;
  try {
    const { payload: p } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nbf', 'jti'], maxTokenAge: '10m', clockTolerance: 5 });
    const text = (name: string) => typeof p[name] === 'string' ? p[name] as string : '';
    claims = { repository: text('repository'), repository_id: text('repository_id'), repository_owner_id: text('repository_owner_id'), ref: text('ref'),
      ref_type: text('ref_type'), workflow_ref: text('workflow_ref'), event_name: text('event_name'), sub: text('sub'), run_id: text('run_id'), run_attempt: text('run_attempt'),
      ...(p.job_workflow_ref !== undefined ? { job_workflow_ref: String(p.job_workflow_ref) } : {}) };
    expires = p.exp!;
  } catch { return fail('unauthorized', 401); }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(claims.repository) || ![claims.repository_id, claims.repository_owner_id, claims.run_id, claims.run_attempt].every(v => /^[1-9]\d*$/.test(v))) {
    return fail('forbidden', 403);
  }
  const body = await captureBody(request, 256);
  if (body.error) return fail(body.error.message, body.error.status);
  let purpose: string;
  try {
    const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.body)));
    purpose = String(value.purpose);
    if (Object.keys(value).length !== 1 || !PURPOSE.test(purpose)) return fail('bad request', 400);
  } catch { return fail('bad request', 400); }
  const bot = env.BOT.getByName(OBJECT_NAME);
  const matched = matchActionsRule(await bot.actionsRuleList() as ActionsRule[], claims, purpose);
  if ('status' in matched) return fail(matched.error, matched.status);
  const { rule, grant: allowed } = matched;
  // A run attempt can mint each purpose of a rule once. Only nonsecret IDs enter durable storage.
  if (!await bot.claimCredential(`${rule.id}:${claims.repository_id}:${claims.run_id}:${claims.run_attempt}:${purpose}`, expires)) return fail('already exchanged', 409);
  let grant;
  try { grant = await new GitHubApp(cfg.github_app_id, cfg.github_app_private_key).grantWith(allowed.repository, allowed.permissions); }
  catch { return fail('token unavailable', 502); }
  // The admin page lists issued tokens without the token itself; a failed record never withholds the grant.
  try {
    await bot.recordTokenGrant({ issued_at: new Date().toISOString(), expires_at: grant.expires_at, source: 'actions',
      identity: `${rule.name} · ${claims.repository} run ${claims.run_id}#${claims.run_attempt}`, repository: allowed.repository, purpose, permissions: describePermissions(allowed.permissions) });
  } catch { /* informational only */ }
  return jsonResponse({ ...grant, repository: allowed.repository, purpose, permissions: allowed.permissions });
}

/**
 * Read-only GitCode sync records for the dashboard's own source. No credential is
 * minted and nothing is archived; the payload is built only from sanitized state.
 */
export async function readGitCodeSync(request: Request, env: WorkerEnv): Promise<Response> {
  // Reading records needs only the collector identity, so a missing App still yields its reason.
  const verified = await verifyCollector(request, env, false);
  if (verified instanceof Response) return verified;
  const sync = verified.cfg.gitcode_sync;
  if (!sync.enabled) return jsonResponse({ ok: true, ...disabledSync(sync.disabled_reasons), records: [], pulls: [] });
  if (sync.source.toLowerCase() !== verified.source.toLowerCase()) return fail('forbidden', 403);
  try { return jsonResponse(await env.BOT.getByName(OBJECT_NAME).gitcodeSync()); }
  catch { return fail('sync records unavailable', 503); }
}
