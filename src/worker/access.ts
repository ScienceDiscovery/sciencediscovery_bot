import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { jsonResponse } from '../core/http.js';
import type { WorkerEnv } from './env.js';

let cached: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

/** Access headers are assertions, not proof. Verify against a configured issuer. */
export async function authorizeAdmin(request: Request, env: WorkerEnv): Promise<Response | null> {
  const issuer = String(env.SDBOT_ACCESS_ISSUER || '');
  const audience = String(env.SDBOT_ACCESS_AUD || '');
  const hostname = String(env.SDBOT_ADMIN_HOSTNAME || '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience || !hostname) {
    return jsonResponse({ ok: false, error: 'admin unavailable' }, 503);
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (new URL(request.url).hostname !== hostname || !token || token.length > 16384) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  try {
    if (cached?.issuer !== issuer) cached = { issuer, keys: createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'), {
      timeoutDuration: 5000,
      // workerd supports manual redirects; jose rejects every non-200 response.
      [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'manual' }),
    }) };
    const { payload } = await jwtVerify(token, cached.keys, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('invalid subject');
    return null;
  } catch { return jsonResponse({ ok: false, error: 'unauthorized' }, 401); }
}
