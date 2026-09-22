/** Local workerd integration harness only. Not a deployment entry point. */
import { configFromEnv, type Environment } from '../../src/core/config.js';
import { BotApplication } from '../../src/core/http.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { GitHubApp } from '../../src/core/github-app.js';
import { MemoryArchive } from './memory-archive.js';
let app: BotApplication;
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    app ||= new BotApplication(new Pipeline(configFromEnv(env), new MemoryArchive()), async () => 'test panel');
    const url = new URL(request.url);
    if (url.pathname === '/_test/jwt') return Response.json({ jwt: await new GitHubApp('test-app', env.TEST_PRIVATE_KEY!).jwt() });
    if (url.pathname === '/_test/events') return Response.json({ events: await app.pipeline.store.recent(50) });
    if (url.pathname.startsWith('/_test/admin/')) {
      url.pathname = url.pathname.slice('/_test/admin'.length);
      return app.admin(new Request(url, request));
    }
    return app.webhook(request);
  },
};
