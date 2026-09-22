const { test, expect } = require('../.e2e/node_modules/@playwright/test');

test('Actions acceptance is displayed as collection triggered, with no claim of completed deployment', async ({ page }, testInfo) => {
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.board = { enabled: true, targets: [{ source: 'openJiuwen-ai/sciencediscovery', repository: 'ScienceDiscovery/github-status-board',
      execution: 'github_actions', requested: 1, dispatched: 1, running: false, pending: false,
      last_dispatch: '2026-09-22T08:00:00Z', last_success: null, commit: null, error: null }] };
    await route.fulfill({ response, json: state });
  });
  await page.goto('/#token=' + process.env.SDBOT_E2E_ADMIN_TOKEN);
  await expect(page.locator('#cards')).toContainText('已触发采集');
  await expect(page.locator('#cards')).toContainText('最近触发');
  await expect(page.locator('#cards')).not.toContainText('已提交发布');
  await expect(page.locator('#cards')).toContainText('未启用此平台接入');
  await expect(page.locator('#cards')).not.toContainText('接受未签名投递');
  await page.screenshot({ path: testInfo.outputPath('workers-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#cards')).toContainText('已触发采集');
  await page.locator('.card').filter({ hasText: 'ScienceDiscovery/github-status-board' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('workers-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
