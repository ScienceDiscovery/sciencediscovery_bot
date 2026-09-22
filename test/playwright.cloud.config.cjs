const { defineConfig } = require('../.e2e/node_modules/@playwright/test');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
process.env.SDBOT_CLOUD_E2E_RUN_DIR ||= resolve(root, '.e2e/runs/cloud-' + randomUUID());
process.env.SDBOT_E2E_SECRET ||= randomBytes(32).toString('hex');
for (const [key, dir] of Object.entries({ PLAYWRIGHT_BROWSERS_PATH: '.e2e/browsers', TMPDIR: '.e2e/tmp', XDG_CACHE_HOME: '.e2e/cache', XDG_CONFIG_HOME: '.e2e/config' })) {
  process.env[key] = resolve(root, dir); mkdirSync(process.env[key], { recursive: true });
}
module.exports = defineConfig({ testDir: __dirname, testMatch: 'journey-cloud-admin.spec.cjs', workers: 1,
  outputDir: resolve(root, '.e2e/cloud-results'), reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:18893', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node test/cloud-admin-server.mjs', cwd: root, url: 'http://127.0.0.1:18893/healthz', reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
});
