import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { targets } from '../core/config.js';
import { captureBody, jsonResponse } from '../core/http.js';
import { GitHubApp } from '../core/github-app.js';
import { object } from '../core/types.js';
import { OBJECT_NAME, workerConfig, type WorkerEnv } from './env.js';

const issuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks'), {
  timeoutDuration: 5000,
  [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'manual' }),
});
const fail = (error: string, status: number) => jsonResponse({ ok: false, error }, status);

/** This credential protocol is separate from Webhook ingestion and its archive. */
export async function exchangeActionsToken(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== 'POST') return fail('method not allowed', 405);
  const cfg = workerConfig(env), mappings = Object.entries(targets(cfg));
  const repositoryId = String(env.SDBOT_ACTIONS_REPOSITORY_ID || '');
  const ownerId = String(env.SDBOT_ACTIONS_OWNER_ID || '');
  const audience = String(env.SDBOT_ACTIONS_AUDIENCE || '');
  if (mappings.length !== 1 || !/^[1-9]\d*$/.test(repositoryId) || !/^[1-9]\d*$/.test(ownerId) || !audience ||
      !env.SDBOT_ADMIN_HOSTNAME || !cfg.github_app_id || !cfg.github_app_private_key) return fail('exchange unavailable', 503);
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
  const body = await captureBody(request, 256);
  if (body.error) return fail(body.error.message, body.error.status);
  let purpose: string;
  try {
    const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.body)));
    if (Object.keys(value).length !== 1 || !['source', 'target'].includes(String(value.purpose))) return fail('bad request', 400);
    purpose = String(value.purpose);
  } catch { return fail('bad request', 400); }
  // A run attempt can mint each scope once. Only nonsecret IDs enter durable storage.
  if (!await env.BOT.getByName(OBJECT_NAME).claimCredential(runKey + ':' + purpose, expires)) return fail('already exchanged', 409);
  try {
    const repository = purpose === 'source' ? source : destination;
    const grant = await new GitHubApp(cfg.github_app_id, cfg.github_app_private_key).grantForCollection(repository, purpose === 'target');
    return jsonResponse({ ...grant, repository, purpose });
  } catch { return fail('token unavailable', 502); }
}
