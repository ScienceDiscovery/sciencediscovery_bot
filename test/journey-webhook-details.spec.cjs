const { test, expect } = require('../.e2e/node_modules/@playwright/test');
const { randomUUID, createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const origin = 'http://127.0.0.1:18891';
const auth = () => ({ Authorization: 'Bearer ' + process.env.SDBOT_E2E_ADMIN_TOKEN });
async function openPanel(page) {
  await page.goto('/#token=' + process.env.SDBOT_E2E_ADMIN_TOKEN);
  await expect(page.locator('#listeners')).toContainText('18892');
  await expect(page).toHaveURL('http://127.0.0.1:18892/');
}
async function send(request, { path = '/webhook/github', valid = true, delivery = randomUUID() } = {}) {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/github/issues_opened.json')));
  fixture.payload.issue.body = '<img src=x onerror="window.untrustedExecuted=true">';
  const body = JSON.stringify(fixture.payload);
  const signature = createHmac('sha256', process.env.SDBOT_E2E_SECRET).update(body).digest('hex');
  const response = await request.post(origin + path, { data: body, headers: {
    'Content-Type': 'application/json', 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': delivery,
    'X-Hub-Signature-256': valid ? 'sha256=' + signature : 'sha256=wrong', Cookie: 'private=test-cookie-value'
  }});
  return { delivery, body, response, reply: await response.json() };
}
const rowFor = (page, delivery) => page.locator('#rows tr').filter({ hasText: delivery.slice(0, 18) });

test('receive and inspect raw request/response with read-only management', async ({ page, request }, testInfo) => {
  const sent = await send(request);
  expect(sent.response.status()).toBe(200);
  await openPanel(page);
  await rowFor(page, sent.delivery).getByRole('button', { name: '查看详情' }).click();
  const dialog = page.getByRole('dialog', { name: 'Webhook 投递详情' });
  await expect(dialog.locator('#response-title')).toHaveText('返回内容 · HTTP 200');
  await expect(dialog.locator('#request-body')).toContainText('window.untrustedExecuted');
  await dialog.getByLabel('格式化 JSON').uncheck();
  await expect(dialog.locator('#request-body')).toHaveText(sent.body);
  expect(JSON.parse(await dialog.locator('#response-body').textContent())).toEqual(sent.reply);
  await dialog.getByText('请求头（凭据已脱敏）', { exact: true }).click();
  await expect(dialog.locator('#request-headers')).toContainText('[REDACTED]');
  expect(await dialog.textContent()).not.toContain('test-cookie-value');
  expect(await page.evaluate(() => window.untrustedExecuted)).toBeUndefined();
  await dialog.getByLabel('格式化 JSON').check();
  await page.screenshot({ path: testInfo.outputPath('details-desktop.png') });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const before = (await (await request.get('/api/events', { headers: auth() })).json()).count;
  await expect(page.getByRole('button', { name: '重放', exact: true })).toHaveCount(0);
  const latest = (await (await request.get('/api/events?limit=1', { headers: auth() })).json()).events[0];
  expect((await request.post('/api/replay/' + latest.record_id, { headers: { ...auth(), 'X-Requested-With': 'sciencediscovery-bot' } })).status()).toBe(404);
  expect((await (await request.get('/api/events', { headers: auth() })).json()).count).toBe(before);
  expect((await request.get(origin + '/api/events/' + latest.record_id)).status()).toBe(404);
  expect((await request.get('/api/events/' + latest.record_id)).status()).toBe(401);
  expect((await request.get('/api/events/' + latest.record_id, { headers: { ...auth(), 'Cf-Ray': 'test' } })).status()).toBe(403);
});

test('rejected requests retain body and response, including wrong webhook URL', async ({ page, request }, testInfo) => {
  const rejected = await send(request, { valid: false });
  const wrongPath = await send(request, { path: '/wrong-webhook' });
  expect(rejected.response.status()).toBe(401);
  expect(wrongPath.response.status()).toBe(404);
  await openPanel(page);
  await page.locator('#f-status').selectOption('rejected');
  await rowFor(page, wrongPath.delivery).getByRole('button', { name: '查看详情' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#detail-meta')).toContainText('POST /wrong-webhook');
  await expect(dialog.locator('#response-title')).toHaveText('返回内容 · HTTP 404');
  await dialog.getByLabel('格式化 JSON').uncheck();
  await expect(dialog.locator('#request-body')).toHaveText(wrongPath.body);
  await expect(dialog.locator('#response-body')).toContainText('not found');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('#response-body')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('details-mobile.png') });
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await rowFor(page, rejected.delivery).getByRole('button', { name: '查看详情' }).click();
  await expect(dialog.locator('#response-title')).toHaveText('返回内容 · HTTP 401');
  await expect(dialog.locator('#request-body')).toHaveText(rejected.body);
});

test('empty filtered history remains usable', async ({ page }) => {
  await openPanel(page);
  await page.locator('#f-route').fill('no.such.route');
  await page.locator('#f-route').blur();
  await expect(page.locator('#rows')).toContainText('没有匹配的事件');
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '上一页' })).toBeDisabled();
  await expect(page.locator('#banner')).toBeHidden();
});

test('browse historical pages and show unavailable legacy fields honestly', async ({ page, request }) => {
  await send(request);
  await send(request);
  await openPanel(page);
  await page.locator('#f-limit').fill('1');
  await page.locator('#f-limit').blur();
  await expect(page.locator('#rows tr')).toHaveCount(1);
  const first = await page.locator('#rows').textContent();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('#page-info')).toContainText('第 2–2 条');
  expect(await page.locator('#rows').textContent()).not.toBe(first);
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.locator('#page-info')).toContainText('第 1–1 条');
  await page.locator('#f-route').fill('ping.ping');
  await page.locator('#f-route').blur();
  await page.getByRole('button', { name: '查看详情' }).click();
  await expect(page.locator('#detail-note')).toContainText('历史记录未保存请求头和返回内容');
  await expect(page.locator('#request-body')).toContainText('historical_payload');
  await expect(page.locator('#response-body')).toHaveText('未保存');
});
