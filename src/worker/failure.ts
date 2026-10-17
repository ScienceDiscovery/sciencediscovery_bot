import { jsonResponse } from '../core/http.js';
import { scrub } from '../core/redact.js';

/**
 * Right after a deployment the outer Worker already runs the new code while the Durable Object can
 * still run the previous version for a few minutes. A call to an RPC method the old object does not
 * have, or one cut off by the object's restart, fails with one of these messages.
 */
const VERSION_SWITCH = /does not implement the method|reset because its code was updated|Durable Object is overloaded|Network connection lost/i;
export const switchingVersion = (message: string): boolean => VERSION_SWITCH.test(message);

/**
 * The single answer for an exception nothing else handled. The cause goes to the Worker's log
 * (scrubbed and short) so it can be found later; the client only learns whether retrying soon helps.
 */
export function unavailable(error: unknown, request: Request): Response {
  const name = error instanceof Error ? error.name : typeof error;
  const message = scrub(error instanceof Error ? error.message : String(error), [], 300);
  const switching = switchingVersion(message);
  let path = '';
  try { path = new URL(request.url).pathname.slice(0, 200); } catch { /* an unparsable URL is logged without a path */ }
  console.error(JSON.stringify({ event: 'request_failed', method: request.method, path, error: name, message, switching }));
  if (!switching) return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  return jsonResponse({ ok: false, error: 'the bot is switching to a new version; retry in a minute', retryable: true }, 503,
    new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60' }));
}
