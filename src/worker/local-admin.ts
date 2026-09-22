/** Local runner only. This module is absent from the deployable Worker bundle. */
import { OBJECT_NAME, type WorkerEnv } from './env.js';
import { jsonResponse } from '../core/http.js';
export default {
  async fetch(request: Request, env: WorkerEnv & { PANEL: string }): Promise<Response> {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || [...request.headers.keys()].some(h => h.startsWith('cf-'))) return jsonResponse({ ok: false, error: 'admin listener is local only' }, 403);
    if (request.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) return new Response(env.PANEL, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    return env.BOT.getByName(OBJECT_NAME).admin(request);
  },
};
