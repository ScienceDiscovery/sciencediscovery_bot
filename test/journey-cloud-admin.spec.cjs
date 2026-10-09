const { test, expect } = require('../.e2e/node_modules/@playwright/test');
const { createHmac, randomUUID } = require('node:crypto');

test('authenticated cloud management shows exchanges and listeners without write controls', async ({ page, context, request }, testInfo) => {
  expect((await request.get('/admin/')).status()).toBe(401);
  expect((await request.get('/api/status')).status()).toBe(404);
  const delivery = randomUUID();
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'ScienceDiscovery/sciencediscovery' }, issue: { number: 3, title: '云端管理验收', body: '<img src=x onerror="window.untrustedExecuted=true">' } });
  expect((await request.post('/webhook/github', { data: body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', process.env.SDBOT_E2E_SECRET).update(body).digest('hex') } })).status()).toBe(200);
  await context.addCookies([{ name: 'test_access', value: 'allowed', url: 'http://127.0.0.1:18893', httpOnly: true }]);
  await page.goto('/admin/');
  await expect(page.locator('#listeners')).toContainText('test · 云端记录 · 只读');
  await expect(page.locator('#rows')).toContainText('云端管理验收');
  await expect(page.getByRole('button', { name: '重放', exact: true })).toHaveCount(0);
  await expect(page.locator('#banner')).toBeHidden();
  await page.getByRole('button', { name: '查看详情' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#response-title')).toContainText('HTTP 200');
  await expect(dialog.locator('#request-body')).toContainText('window.untrustedExecuted');
  await dialog.getByLabel('格式化 JSON').uncheck();
  await expect(dialog.locator('#request-body')).toHaveText(body);
  expect(JSON.parse(await dialog.locator('#response-body').textContent()).delivery_id).toBe(delivery);
  expect(await page.evaluate(() => window.untrustedExecuted)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('cloud-details-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('#response-body')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('cloud-details-mobile.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('link', { name: '监听点', exact: true }).click();
  await expect(page.locator('#subscription-count')).toContainText('12 / 12');
  await page.locator('#subscription-search').fill('does-not-match');
  await expect(page.locator('#subscription-list')).toContainText('没有匹配的监听点');
  await page.locator('#subscription-search').clear();
  await page.screenshot({ path: testInfo.outputPath('cloud-listeners-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.clearCookies();
  await page.getByRole('button', { name: '刷新监听点' }).click();
  await expect(page.locator('#banner')).toContainText('重新登录');
});

test('resource usage loads once when opened, never with the 10 s refresh, and explains a missing token', async ({ page, context }, testInfo) => {
  await context.addCookies([{ name: 'test_access', value: 'allowed', url: 'http://127.0.0.1:18893', httpOnly: true }]);
  const counts = { status: 0, usage: 0 };
  page.on('request', r => { const path = new URL(r.url()).pathname; if (path === '/admin/api/status') counts.status++; if (path === '/admin/api/usage') counts.usage++; });
  await page.clock.install();
  await page.goto('/admin/');
  await expect(page.locator('#rows')).toBeVisible();
  // The events page polls every 10 s; none of those polls asks for usage.
  // Step one interval at a time so each poll completes before its abort timer could fire.
  for (let i = 0; i < 3; i++) { await page.clock.runFor(10_000); await page.waitForTimeout(500); }
  await expect.poll(() => counts.status).toBeGreaterThanOrEqual(4);
  expect(counts.usage).toBe(0);
  await page.getByRole('link', { name: '资源用量', exact: true }).click();
  await expect(page.locator('#usage-cards')).toContainText('SQLite 数据库');
  await expect(page.locator('#usage-estimate')).toContainText('$13.76');
  await expect(page.locator('#usage-notes')).toContainText('估算，不是发票');
  await expect(page.locator('#usage-notes')).toContainText('每天 500 万行读、10 万行写');
  await expect(page.locator('#usage-notes')).toContainText('2026-09-30');
  expect(counts.usage).toBe(1);
  const status = counts.status;
  // On the usage view nothing polls at all, not even status.
  await page.clock.runFor(20 * 60_000);
  expect([counts.usage, counts.status]).toEqual([1, status]);
  await page.screenshot({ path: testInfo.outputPath('usage-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect.poll(() => counts.usage).toBe(2);

  // A failed read waits 15 minutes before trying again.
  let fail = true;
  await page.route('**/admin/api/usage', route => fail ? route.fulfill({ status: 503, json: { ok: false, error: 'service unavailable' } }) : route.fallback());
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.locator('#usage-state')).toContainText('15 分钟后自动重试');
  await page.clock.runFor(14 * 60_000);
  expect(counts.usage).toBe(3);
  fail = false;
  await page.clock.runFor(60_000 + 1000);
  await expect.poll(() => counts.usage).toBe(4);
  await expect(page.locator('#usage-state')).toContainText('读取于');

  // Without SDBOT_ANALYTICS_TOKEN the Worker returns local size and counters only (see worker-usage.test.mjs).
  await page.route('**/admin/api/usage', async route => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, analytics: { status: 'unconfigured', message: '未配置 Analytics token，不能估算操作量' }, estimate: null } });
  });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.locator('#usage-estimate')).toHaveText('未配置 Analytics token，不能估算操作量');
  await expect(page.locator('#usage-cards')).toContainText('SQLite 数据库');
  await expect(page.locator('#usage-cards')).not.toContainText('R2 存储');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('usage-unconfigured-mobile.png'), fullPage: true });
});
