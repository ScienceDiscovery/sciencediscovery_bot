const { defineConfig } = require('../.e2e/node_modules/@playwright/test');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
process.env.SDBOT_E2E_RUN_DIR ||= resolve(root, '.e2e/runs/' + randomUUID());
process.env.SDBOT_E2E_SECRET ||= randomBytes(32).toString('hex');
process.env.SDBOT_E2E_ADMIN_TOKEN ||= randomBytes(32).toString('hex');
const run = process.env.SDBOT_E2E_RUN_DIR;
const data = resolve(run, 'data');
if (!existsSync(data)) {
  mkdirSync(data, { recursive: true });
  writeFileSync(resolve(data, 'legacy.json'), '{"historical_payload":true}');
  writeFileSync(resolve(data, 'events.jsonl'), JSON.stringify({ delivery_id: 'legacy-event', status: 'accepted',
    provider: 'github', kind: 'ping', route: 'ping.ping', received_at: '2026-01-01T00:00:00Z', payload_file: 'legacy.json' }) + '\n');
}
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, '.e2e/browsers');
process.env.TMPDIR = resolve(root, '.e2e/tmp');
process.env.XDG_CACHE_HOME = resolve(root, '.e2e/cache');
process.env.XDG_CONFIG_HOME = resolve(root, '.e2e/config');
module.exports = defineConfig({
  testDir: __dirname, testMatch: 'journey-*.spec.cjs', workers: 1, fullyParallel: false,
  outputDir: resolve(root, '.e2e/results'), reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:18892', browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node dist/node/server.js --webhook-port 18891 --admin-port 18892', cwd: root,
    url: 'http://127.0.0.1:18891/healthz', reuseExistingServer: false,
    env: { SDBOT_DATA_DIR: data, SDBOT_WEBHOOK_HOST: '127.0.0.1', SDBOT_ADMIN_HOST: '127.0.0.1',
      SDBOT_WEBHOOK_SECRET: process.env.SDBOT_E2E_SECRET, SDBOT_GITHUB_WEBHOOK_SECRET: '', SDBOT_GITCODE_WEBHOOK_SECRET: '',
      SDBOT_BOARD_TARGETS: '', SDBOT_BOARD_REPO: '', SDBOT_BOARD_TRACK_REPO: '', SDBOT_BOARD_GITHUB_TOKEN: '',
      SDBOT_GITHUB_APP_ID: '', SDBOT_GITHUB_APP_PRIVATE_KEY: '',
      SDBOT_ADMIN_TOKEN: process.env.SDBOT_E2E_ADMIN_TOKEN, SDBOT_REPOS: '', SDBOT_ADMIN_ENABLED: '1' },
    stdout: 'ignore', stderr: 'ignore' }
});
