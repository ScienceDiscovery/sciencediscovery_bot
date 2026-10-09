// Test-only X.509 certificates built in memory; nothing here is committed key material.
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

const length = n => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag, ...length(content.length)]), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number), out = [40 * a + b];
  for (const value of rest) {
    const digits = []; let v = value;
    do { digits.unshift(v & 0x7f); v >>= 7; } while (v);
    out.push(...digits.map((d, i) => i < digits.length - 1 ? d | 0x80 : d));
  }
  return tlv(0x06, Buffer.from(out));
}
const integer = n => tlv(0x02, Buffer.from([n]));
const time = date => {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
};
const name = cn => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

const authority = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DAY = 86400000;

/** A certificate for a fresh RSA or P-256 key, issued by a throwaway test CA. */
export function makeCertificate({ type = 'rsa', cn = 'caller', notBefore = new Date(Date.now() - DAY), notAfter = new Date(Date.now() + 30 * DAY) } = {}) {
  const pair = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)));
  const tbs = seq(tlv(0xa0, integer(2)), integer(7), algorithm, name('sdbot test CA'), seq(time(notBefore), time(notAfter)), name(cn),
    pair.publicKey.export({ type: 'spki', format: 'der' }));
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, authority.privateKey)])));
  new X509Certificate(der); // the platform parser accepts what the bot will read
  return { certificate: pem('CERTIFICATE', der), privateKey: pair.privateKey, privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
