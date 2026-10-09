import { fromBase64, hex } from './signature.js';

/**
 * Just enough DER reading for a caller certificate: the public key type (which fixes the JWT
 * algorithm), the validity window and a fingerprint. The key itself is imported by jose.
 */
export interface CertificateInfo { pem: string; alg: 'RS256' | 'ES256'; subject: string; not_before: string; not_after: string; fingerprint: string }
export class CertificateError extends Error {}

type Node = { tag: number; start: number; end: number };
function read(der: Uint8Array, offset: number): Node {
  if (offset + 2 > der.length) throw new CertificateError('truncated certificate');
  const tag = der[offset];
  let length = der[offset + 1], start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || count > 3 || start + count > der.length) throw new CertificateError('unsupported certificate length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i];
    start += count;
  }
  if (start + length > der.length) throw new CertificateError('truncated certificate');
  return { tag, start, end: start + length };
}
function children(der: Uint8Array, node: Node): Node[] {
  const out: Node[] = [];
  for (let offset = node.start; offset < node.end;) { const child = read(der, offset); out.push(child); offset = child.end; }
  return out;
}
const bytes = (der: Uint8Array, node: Node) => der.subarray(node.start, node.end);
const same = (a: Uint8Array, b: number[]) => a.length === b.length && b.every((v, i) => a[i] === v);
const RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const EC = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const P256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const COMMON_NAME = [0x55, 0x04, 0x03];

function time(der: Uint8Array, node: Node): string {
  const value = new TextDecoder().decode(bytes(der, node));
  const match = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(value) : node.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(value) : null;
  if (!match) throw new CertificateError('unsupported certificate validity time');
  const year = node.tag === 0x17 ? (Number(match[1]) >= 50 ? 1900 : 2000) + Number(match[1]) : Number(match[1]);
  const at = Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (!Number.isFinite(at)) throw new CertificateError('invalid certificate validity time');
  return new Date(at).toISOString();
}
function commonName(der: Uint8Array, name: Node): string {
  for (const set of children(der, name)) for (const pair of children(der, set)) {
    const [oid, value] = children(der, pair);
    if (oid && value && same(bytes(der, oid), COMMON_NAME)) return new TextDecoder().decode(bytes(der, value)).slice(0, 200);
  }
  return '';
}

/** Accepts exactly one CERTIFICATE block and refuses anything that carries a private key. */
export async function parseCertificate(input: string): Promise<CertificateInfo> {
  const text = String(input || '').replaceAll('\r\n', '\n').trim();
  if (/PRIVATE KEY/.test(text)) throw new CertificateError('the PEM contains a private key; upload only the public certificate');
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)];
  if (blocks.length !== 1 || blocks[0][1] !== 'CERTIFICATE' || text.replace(blocks[0][0], '').trim()) throw new CertificateError('expected exactly one PEM CERTIFICATE block');
  const body = blocks[0][2].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length > 16384) throw new CertificateError('invalid certificate encoding');
  const der = fromBase64(body);
  try {
    const cert = read(der, 0);
    if (cert.tag !== 0x30 || cert.end !== der.length) throw new CertificateError('not a DER certificate');
    const tbs = children(der, cert)[0];
    const fields = children(der, tbs);
    const at = fields[0]?.tag === 0xa0 ? 1 : 0;
    const [validity, subject, spki] = [fields[at + 3], fields[at + 4], fields[at + 5]];
    if (!validity || !subject || !spki) throw new CertificateError('incomplete certificate');
    const [notBefore, notAfter] = children(der, validity);
    const [algorithm] = children(der, spki), [oid, params] = children(der, algorithm);
    const alg = same(bytes(der, oid), RSA) ? 'RS256' : same(bytes(der, oid), EC) && params?.tag === 0x06 && same(bytes(der, params), P256) ? 'ES256' : null;
    if (!alg) throw new CertificateError('only RSA or P-256 EC certificates are supported');
    const fingerprint = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', der)));
    return { pem: `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`, alg, subject: commonName(der, subject),
      not_before: time(der, notBefore), not_after: time(der, notAfter), fingerprint };
  } catch (error) {
    if (error instanceof CertificateError) throw error;
    throw new CertificateError('could not read the certificate');
  }
}
