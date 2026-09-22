const { defineConfig } = require('../.e2e/node_modules/@playwright/test');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
process.env.SDBOT_WORKER_E2E_RUN_DIR ||= resolve(root, '.e2e/runs/worker-' + randomUUID());
const run = process.env.SDBOT_WORKER_E2E_RUN_DIR;
mkdirSync(run, { recursive: true });
process.env.SDBOT_E2E_SECRET ||= randomBytes(32).toString('hex');
process.env.SDBOT_E2E_ADMIN_TOKEN ||= randomBytes(32).toString('hex');
const env = resolve(run, 'worker.env');
writeFileSync(env, `SDBOT_GITHUB_WEBHOOK_SECRET=${process.env.SDBOT_E2E_SECRET}\nSDBOT_ADMIN_TOKEN=${process.env.SDBOT_E2E_ADMIN_TOKEN}\n`, { mode: 0o600 });
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, '.e2e/browsers');
process.env.TMPDIR = resolve(root, '.e2e/tmp');
process.env.XDG_CACHE_HOME = resolve(root, '.e2e/cache');
process.env.XDG_CONFIG_HOME = resolve(root, '.e2e/config');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: ['journey-webhook-details.spec.cjs', 'journey-local-time.spec.cjs', 'journey-listeners.spec.cjs', 'worker-journey.spec.cjs'],
  // Legacy JSONL belongs to the Node adapter and is covered by its own journey.
  grepInvert: /browse historical pages and show unavailable legacy fields honestly/,
  workers: 1, fullyParallel: false, outputDir: resolve(root, '.e2e/workers-results'), reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:18892', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `node tools/workers-local.mjs --env ${env} --state ${resolve(run, 'state')}`, cwd: root,
    url: 'http://127.0.0.1:18891/healthz', reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
});
