/**
 * Strip credentials from any text that may reach records, checks or Pages:
 * configured secrets, Authorization/token assignments and user:password@ URLs.
 * Redaction happens before truncation so a cut can never expose half a secret.
 */
export function scrub(value: string, secrets: readonly string[] = [], max = 400, multiline = false): string {
  let text = String(value);
  for (const secret of secrets) if (secret && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization|proxy-authorization|private-token|access[_-]?token|x-access-token|password|passwd|secret|token)(\s*["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"'&,;)|]+/gi, '$1$2[REDACTED]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, max);
}
