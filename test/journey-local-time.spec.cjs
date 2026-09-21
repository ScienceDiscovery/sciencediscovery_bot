const { test, expect } = require('../.e2e/node_modules/@playwright/test');

// Fixed API timestamps isolate display semantics from the machine's clock/timezone.
const timestamps = ['2026-01-01T00:30:00+0000', '2026-07-01T00:30:00Z',
  '2026-07-01T08:30:00+08:00', 'invalid-legacy-time', null];
for (const [timezoneId, expected] of [
  ['Asia/Shanghai', ['2026/01/01 08:30:00', '2026/07/01 08:30:00', '2026/07/01 08:30:00']],
  ['America/New_York', ['2025/12/31 19:30:00', '2026/06/30 20:30:00', '2026/06/30 20:30:00']],
]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });
    test('list and detail use browser timezone while original exchange stays intact', async ({ page }, testInfo) => {
      const events = timestamps.map((received_at, i) => ({
        received_at, record_id: `time-${i}`, delivery_id: `time-delivery-${i}`,
        status: 'accepted', provider: 'github', route: 'issue.opened', number: i + 1,
        repo: 'example/project', title: '浏览器时区显示', verification: 'hmac-sha256', hooks: []
      }));
      const originalBody = JSON.stringify({ created_at: timestamps[0] });
      await page.route('**/api/events?*', route => route.fulfill({ json: {
        ok: true, events, count: events.length, offset: 0, has_more: false
      }}));
      await page.route('**/api/events/time-*', route => {
        const i = Number(new URL(route.request().url()).pathname.split('-').at(-1));
        return route.fulfill({ json: {
          ok: true, record: events[i], legacy: false,
          request: { method: 'POST', path: '/webhook/github', headers: {}, body: originalBody,
            body_available: true, body_complete: true, body_encoding: 'utf-8' },
          response: { status: 200, headers: { Date: 'Thu, 01 Jan 2026 00:30:00 GMT' }, body: '{"ok":true}' }
        }});
      });
      await page.goto('/#token=' + process.env.SDBOT_E2E_ADMIN_TOKEN);
      await expect(page.locator('#listeners')).toContainText('18892');
      await expect(page.locator('#timezone')).toHaveText('时间显示：' + timezoneId);
      const values = [...expected, 'invalid-legacy-time', '—'];
      for (let i = 0; i < values.length; i++) {
        const row = page.locator('#rows tr').nth(i);
        await expect(row.locator('td').first()).toHaveText(values[i]);
        await expect(row.locator('td').first()).toHaveAttribute('title', timestamps[i] || '');
        await row.getByRole('button', { name: '查看详情' }).click();
        await expect(page.locator('#detail-meta')).toContainText(values[i] + ' · POST /webhook/github');
        await expect(page.locator('#detail-meta')).toHaveAttribute('title', timestamps[i] || '');
        await page.getByLabel('格式化 JSON').uncheck();
        await expect(page.locator('#request-body')).toHaveText(originalBody);
        await page.getByRole('button', { name: '关闭', exact: true }).click();
      }
      await page.screenshot({ path: testInfo.outputPath('timezone-desktop.png') });
      await page.locator('#rows tr').first().getByRole('button', { name: '查看详情' }).click();
      await page.getByText('返回头', { exact: true }).click();
      await expect(page.locator('#response-headers')).toContainText('Thu, 01 Jan 2026 00:30:00 GMT');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('#detail-meta')).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('timezone-mobile.png') });
    });
  });
}
