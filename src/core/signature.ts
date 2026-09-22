import { utf8, type Verification } from './types.js';

export const detectProvider = (headers: Headers): string => headers.has('x-github-event') ? 'github' : headers.has('x-gitcode-event') ? 'gitcode' : '';
export const hex = (bytes: Uint8Array): string => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export function base64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
export const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function digest(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(body: Uint8Array, secret: string): Promise<string> {
  return 'sha256=' + hex(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new Uint8Array(body))));
}
export async function equalSecret(value: string, expected: string): Promise<boolean> {
  // HMAC verification avoids timing comparisons of variable-length bearer/token strings.
  const key = await hmacKey(expected);
  const signature = await crypto.subtle.sign('HMAC', key, utf8.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, utf8.encode(value));
}
export async function verify(provider: string, headers: Headers, body: Uint8Array, secret?: string): Promise<Verification> {
  if (!secret) return { ok: true, mode: 'unsigned', reason: 'no secret configured' };
  if (!['github', 'gitcode'].includes(provider)) return { ok: false, mode: 'rejected', reason: 'unknown provider' };
  const signature = headers.get(provider === 'github' ? 'x-hub-signature-256' : 'x-gitcode-signature-256');
  if (signature) {
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    const encoded = /^sha256=(.+)$/i.exec(signature)?.[1] || '';
    if (/^[0-9a-f]{64}$/.test(encoded)) bytes = Uint8Array.from(encoded.match(/../g)!, v => parseInt(v, 16));
    else if (provider === 'gitcode' && /^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
      const decoded = fromBase64(encoded); if (base64(decoded) === encoded) bytes = decoded;
    }
    const ok = !!bytes && await crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, new Uint8Array(body));
    return { ok, mode: ok ? 'hmac-sha256' : 'rejected', reason: ok ? '' : 'signature mismatch' };
  }
  if (provider === 'gitcode' && headers.has('x-gitcode-token')) {
    const ok = await equalSecret(headers.get('x-gitcode-token')!, secret);
    return { ok, mode: ok ? 'token' : 'rejected', reason: ok ? '' : 'token mismatch' };
  }
  return { ok: false, mode: 'rejected', reason: 'missing signature' };
}
