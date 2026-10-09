// Stand-in Cloudflare Access issuer for workerd tests: a signing key, its JWKS and an admin request helper.
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export const ACCESS = { issuer: 'https://test-admin.cloudflareaccess.com', audience: 'isolated-audience' };
export async function accessFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'isolated-key', alg: 'RS256', use: 'sig' };
  const assertion = await new SignJWT({ sub: 'test-member' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(ACCESS.issuer)
    .setAudience(ACCESS.audience).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  return {
    bindings: { SDBOT_ACCESS_ISSUER: ACCESS.issuer, SDBOT_ACCESS_AUD: ACCESS.audience, SDBOT_ADMIN_HOSTNAME: 'localhost' },
    jwks: request => request.url === ACCESS.issuer + '/cdn-cgi/access/certs' ? Response.json({ keys: [jwk] }) : null,
    /** An authenticated same-origin admin request; JSON bodies are encoded. */
    admin: (mf, path, { method = 'GET', body, headers = {} } = {}) => mf.dispatchFetch('http://localhost' + path, { method,
      headers: { 'cf-access-jwt-assertion': assertion, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }),
  };
}
