const { test, expect } = require('../.e2e/node_modules/@playwright/test');
const { createHmac, randomUUID } = require('node:crypto');

test('authenticated cloud management shows exchanges and listeners without ingestion replay', async ({ page, context, request }, testInfo) => {
  expect((await request.get('/admin/')).status()).toBe(401);
  expect((await request.get('/api/status')).status()).toBe(404);
  const delivery = randomUUID();
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'ScienceDiscovery/sciencediscovery' }, issue: { number: 3, title: '云端管理验收', body: '<img src=x onerror="window.untrustedExecuted=true">' } });
  expect((await request.post('/webhook/github', { data: body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', process.env.SDBOT_E2E_SECRET).update(body).digest('hex') } })).status()).toBe(200);
  await context.addCookies([{ name: 'test_access', value: 'allowed', url: 'http://127.0.0.1:18893', httpOnly: true }]);
  await page.goto('/admin/');
  await expect(page.locator('#listeners')).toContainText('test · 云端记录 · 投递只读');
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
  await expect(page.locator('#subscription-list')).toContainText('board.on_workflow_run');
  await page.locator('#subscription-search').fill('does-not-match');
  await expect(page.locator('#subscription-list')).toContainText('没有匹配的监听点');
  await page.locator('#subscription-search').clear();
  await page.screenshot({ path: testInfo.outputPath('cloud-listeners-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.clearCookies();
  await page.getByRole('button', { name: '刷新监听点' }).click();
  await expect(page.locator('#banner')).toContainText('重新登录');
});

test('the admin page reads once on load and again only when someone asks', async ({ page, context, request }, testInfo) => {
  for (const delivery of [randomUUID(), randomUUID()]) {
    const body = JSON.stringify({ action: 'opened', repository: { full_name: 'ScienceDiscovery/sciencediscovery' }, issue: { number: 4, title: '读取次数验收' } });
    expect((await request.post('/webhook/github', { data: body, headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', process.env.SDBOT_E2E_SECRET).update(body).digest('hex') } })).status()).toBe(200);
  }
  await context.addCookies([{ name: 'test_access', value: 'allowed', url: 'http://127.0.0.1:18893', httpOnly: true }]);
  const counts = { status: 0, events: 0, listeners: 0, usage: 0 };
  page.on('request', r => { const name = new URL(r.url()).pathname.replace('/admin/api/', ''); if (name in counts) counts[name]++; });
  const reads = expected => expect.poll(() => ({ ...counts })).toEqual(expected);
  await page.clock.install();
  await page.goto('/admin/');
  // Page load: status, the current list and usage, once each.
  await reads({ status: 1, events: 1, listeners: 0, usage: 1 });
  await expect(page.locator('#reload')).toBeVisible();
  await expect(page.locator('#events-page')).not.toContainText('自动刷新');
  // Nothing polls: 30 seconds, then 15 more minutes, and the tab becoming visible again read nothing.
  await page.clock.runFor(30_000);
  await page.waitForTimeout(500);
  expect(counts).toEqual({ status: 1, events: 1, listeners: 0, usage: 1 });
  await page.clock.runFor(15 * 60_000);
  await page.waitForTimeout(500);
  expect(counts).toEqual({ status: 1, events: 1, listeners: 0, usage: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(500);
  expect(counts).toEqual({ status: 1, events: 1, listeners: 0, usage: 1 });
  // Refresh reloads everything; filters and paging reload the status and the list only.
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await reads({ status: 2, events: 2, listeners: 0, usage: 2 });
  await page.locator('#f-limit').fill('1');
  await page.locator('#f-limit').press('Tab');
  await reads({ status: 3, events: 3, listeners: 0, usage: 2 });
  await page.getByRole('button', { name: '下一页' }).click();
  await reads({ status: 4, events: 4, listeners: 0, usage: 2 });
  await expect(page.locator('#page-info')).toHaveText('第 2–2 条');
  await page.getByRole('link', { name: '监听点', exact: true }).click();
  await reads({ status: 5, events: 4, listeners: 1, usage: 2 });
  // The usage view shows what the page load already read.
  await page.getByRole('link', { name: '资源用量', exact: true }).click();
  await expect(page.locator('#usage-cards')).toContainText('SQLite 数据库');
  await expect(page.locator('#usage-estimate')).toContainText('$13.76');
  await expect(page.locator('#usage-notes')).toContainText('估算，不是发票');
  await expect(page.locator('#usage-notes')).toContainText('每天 500 万行读、10 万行写');
  await expect(page.locator('#usage-notes')).toContainText('2026-09-30');
  // The Free plan day table, from the same response: today is over on three metrics; an earlier day is not.
  await expect(page.locator('#usage-page h3', { hasText: 'Free 计划每日上限（假设，不是账单）' })).toBeVisible();
  const today = new Date().toISOString().slice(0, 10), first = today.slice(0, 8) + '01';
  const dayRow = date => page.locator('#free-days tr', { has: page.locator('td', { hasText: new RegExp('^' + date + '$') }) });
  await expect(dayRow(today).locator('td').last()).toHaveText('超出：请求、时长、行写');
  await expect(dayRow(today).locator('td.bad')).toHaveCount(4);
  if (first !== today) {
    await expect(dayRow(first).locator('td').last()).toHaveText('未超出');
    await expect(dayRow(first).locator('td.bad')).toHaveCount(0);
  }
  await expect(page.locator('#free-days tr').last()).toContainText('不按天重置');
  await expect(page.locator('#free-days tr').last().locator('td').last()).toHaveText('未超出');
  await expect(page.locator('#free-scope')).toContainText('数字只含本实例的 archive-v1');
  await expect(page.locator('#free-days')).not.toContainText('$');
  // Every figure with a limit carries a bar and a written percentage; past 100 % the bar stops, the number does not.
  const bar = cell => cell.locator('.meter-bar > span');
  const paidRow = item => page.locator('#usage-estimate tr', { has: page.locator('td', { hasText: new RegExp('^' + item + '$') }) });
  await expect(paidRow('SQLite 行写').locator('.meter')).toHaveClass(/over/);
  await expect(paidRow('SQLite 行写').locator('.meter-text')).toHaveText('120.0%（超出）');
  await expect(bar(paidRow('SQLite 行写'))).toHaveAttribute('style', 'width:100.00%');
  await expect(paidRow('R2 Class B').locator('.meter-text')).toHaveText('20.0%');
  await expect(bar(paidRow('R2 Class B'))).toHaveAttribute('style', 'width:20.00%');
  await expect(page.locator('#usage-estimate .meter')).toHaveCount(8);
  const written = date => dayRow(date).locator('td').nth(4);
  await expect(written(today).locator('.meter-text')).toHaveText('59,950%（超出）');
  await expect(written(today).locator('.meter-text')).toBeVisible();
  await expect(bar(written(today))).toHaveAttribute('style', 'width:100.00%');
  if (first !== today) {
    await expect(written(first).locator('.meter-text')).toHaveText('50.0%');
    await expect(bar(written(first))).toHaveAttribute('style', 'width:50.00%');
  }
  await expect(page.locator('#free-days tr').last().locator('.meter')).toHaveCount(1);
  await expect(page.locator('#usage-cards .card', { hasText: 'R2 存储' }).locator('.meter-text')).toHaveText('每月免费 10 GB 120.0%（超出）');
  await expect(page.locator('#usage-cards .card', { hasText: '今日（UTC）' }).locator('.meter')).toHaveCount(2);
  expect(counts).toEqual({ status: 5, events: 4, listeners: 1, usage: 2 });
  // Reading the table sends nothing more as time passes.
  await page.clock.runFor(15 * 60_000);
  await page.waitForTimeout(500);
  expect(counts).toEqual({ status: 5, events: 4, listeners: 1, usage: 2 });
  await page.screenshot({ path: testInfo.outputPath('usage-desktop.png'), fullPage: true });

  // A failed read is not retried by itself.
  let fail = true;
  await page.route('**/admin/api/usage', route => fail ? route.fulfill({ status: 503, json: { ok: false, error: 'service unavailable' } }) : route.fallback());
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.locator('#usage-state')).toContainText('点击「刷新用量」重试');
  await reads({ status: 6, events: 4, listeners: 1, usage: 3 });
  // A failed usage read is not retried: 30 seconds and then 15 minutes later the counts stand.
  await page.clock.runFor(30_000);
  await page.waitForTimeout(500);
  expect(counts).toEqual({ status: 6, events: 4, listeners: 1, usage: 3 });
  await page.clock.runFor(15 * 60_000);
  await page.waitForTimeout(500);
  expect(counts).toEqual({ status: 6, events: 4, listeners: 1, usage: 3 });
  fail = false;
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.locator('#usage-state')).toContainText('读取于');
  expect(counts.usage).toBe(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('usage-meters-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // An unknown figure draws no bar and is never 0 %.
  await page.route('**/admin/api/usage', async route => {
    const real = await (await route.fetch()).json();
    real.estimate.lines.find(line => line.item === 'SQLite 行读').used = null;
    Object.assign(real.free_plan.days[0], { rows_read: null, unknown: ['rows_read'] });
    real.analytics.r2.storage_bytes = null;
    await route.fulfill({ json: real });
  });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(paidRow('SQLite 行读').locator('td').nth(3)).toHaveText('读取失败');
  await expect(paidRow('SQLite 行读').locator('.meter')).toHaveCount(0);
  await expect(dayRow(today).locator('td').nth(3)).toHaveText('读取失败');
  await expect(dayRow(today).locator('td').nth(3).locator('.meter')).toHaveCount(0);
  await expect(page.locator('#usage-cards .card', { hasText: 'R2 存储' })).toContainText('读取失败');
  await expect(page.locator('#usage-cards .card', { hasText: 'R2 存储' }).locator('.meter')).toHaveCount(0);
  await page.unrouteAll();

  // Without SDBOT_ANALYTICS_TOKEN the Worker returns local size and counters only (see worker-usage.test.mjs).
  await page.route('**/admin/api/usage', async route => {
    const real = await (await route.fetch()).json();
    const message = '未配置 Analytics token，不能估算操作量';
    await route.fulfill({ json: { ...real, analytics: { status: 'unconfigured', message }, estimate: null, free_plan: { ...real.free_plan, days: null, reason: message } } });
  });
  await page.getByRole('button', { name: '刷新用量' }).click();
  await expect(page.locator('#usage-estimate')).toHaveText('未配置 Analytics token，不能估算操作量');
  await expect(page.locator('#usage-cards')).toContainText('SQLite 数据库');
  await expect(page.locator('#usage-cards')).not.toContainText('R2 存储');
  await expect(page.locator('#free-days tr').first()).toHaveText('未配置 Analytics token，不能估算操作量');
  await expect(page.locator('#free-days tr').last()).toContainText('不按天重置');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('usage-unconfigured-mobile.png'), fullPage: true });
});

test('forwarding and certificate callers can be configured on a 390 px screen without polling', async ({ page, context, request }, testInfo) => {
  const { makeCertificate } = await import('../tests-ts/support/certificates.mjs');
  await context.addCookies([{ name: 'test_access', value: 'allowed', url: 'http://127.0.0.1:18893', httpOnly: true }]);
  await page.setViewportSize({ width: 390, height: 844 });
  const reads = [];
  page.on('request', r => { const path = new URL(r.url()).pathname; if (path.startsWith('/admin/api/')) reads.push(`${r.method()} ${path}`); });
  page.on('dialog', dialog => dialog.accept());
  await page.clock.install();
  await page.goto('/admin/#forwards');
  await expect(page.locator('#forward-count')).toContainText('/ 20 条订阅');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  // A private address is refused with the reason; a public HTTPS target is saved.
  await page.getByRole('button', { name: '新增订阅' }).click();
  const form = page.locator('#forward-form');
  await form.getByLabel('名称').fill('内网目标');
  await form.getByLabel('目标 URL').fill('https://10.0.0.8/hook');
  await form.getByLabel('议题（Issue）', { exact: true }).check();
  await form.getByRole('button', { name: '保存订阅' }).click();
  await expect(form.locator('.form-error')).toContainText('loopback, private, link-local or reserved address');
  await form.getByLabel('名称').fill('Issue 转发');
  await form.getByLabel('目标 URL').fill('https://hooks.example/issues');
  await form.getByLabel('gitcode').check();
  await form.getByLabel('合并请求（PR）', { exact: true }).check();
  const issueActions = form.locator('[data-forward-type="issue"]');
  const prActions = form.locator('[data-forward-type="pull_request"]');
  await expect(form).toContainText('不选动作表示该类型全部转发');
  // Native label titles cover both the checkbox and its visible Chinese text.
  const optionLabels = form.locator('#forward-types label');
  await expect(optionLabels).toHaveCount(27);
  expect(await optionLabels.evaluateAll(labels => labels.every(label => label.title.trim() && label.querySelector('input[type="checkbox"]')))).toBe(true);
  const commentLabel = form.locator('[data-forward-type="issue_comment"] > label');
  const reviewLabel = form.locator('[data-forward-type="pull_request_review"] > label');
  await expect(commentLabel).toHaveAttribute('title', "写在议题或合并请求对话区里的评论。GitHub 用 issue_comment，在 PR 对话区发言也属于这里；GitCode 用 Note Hook。这不是正式评审。");
  await expect(reviewLabel).toHaveAttribute('title', "GitHub 的正式评审 pull_request_review，以及 diff 上的行间评论 pull_request_review_comment。当前没有 GitCode 事件被归入这一类；GitCode 的合并请求评论在「评论」里。");
  await expect(prActions.locator('input[value="pull_request:edited"]').locator('..')).toHaveAttribute('title', "修改标题、正文或说明，不包含分支上的新提交。GitHub 的 edited；GitCode 不带新提交记录的 update。");
  await expect(prActions.locator('input[value="pull_request:synchronize"]').locator('..')).toHaveAttribute('title', "向合并请求的分支推送了新提交。GitHub 的 synchronize；GitCode 带 oldrev 的 update。");
  await commentLabel.hover();
  await commentLabel.locator('input').hover();
  expect(await commentLabel.locator('input').evaluate(input => input.closest('label').title)).toContain('这不是正式评审');

  await issueActions.getByLabel('新建', {exact: true}).check();
  await prActions.getByLabel('合并', {exact: true}).check();
  await expect(issueActions.locator('.forward-actions')).toBeVisible();
  await expect(form).toContainText('X-Sdbot-Signature-256');
  await form.getByLabel(/签名密钥/).fill('journey-secret');
  // Limit to one repository and add an Authorization header; its value is masked while typing.
  await form.getByLabel(/仓库（可选/).fill('openJiuwen-ai/sciencediscovery');
  await form.getByRole('button', { name: '添加标头' }).click();
  await form.getByLabel('标头名称').fill('Authorization');
  await form.getByLabel('标头值', { exact: true }).fill('Bearer crsr_journey');
  await expect(form.getByLabel('标头值', { exact: true })).toHaveAttribute('type', 'password');
  expect(await overflow()).toBe(true);
  await form.getByRole('button', { name: '保存订阅' }).click();
  await expect(form).toBeHidden();
  const card = page.locator('#forward-list article', { hasText: 'Issue 转发' });
  await expect(card).toContainText('https://hooks.example/issues');
  await expect(card).toContainText('已设置签名密钥');
  await expect(card).toContainText('尚未转发');
  await expect(card).toContainText('议题（Issue）：新建');
  await expect(card).toContainText('合并请求（PR）：合并');
  const saved = await (await page.request.get('/admin/api/forwards')).json();
  expect(saved.subscriptions.find(sub => sub.name === 'Issue 转发').actions).toEqual(['issue:opened', 'pull_request:merged']);
  await expect(card).toContainText('仓库：openjiuwen-ai/sciencediscovery');
  await expect(card).toContainText('附加标头：Authorization');
  await expect(page.locator('#forward-list')).not.toContainText('crsr_journey');
  // Edit keeps the stored secret readable to the admin, then changes the types.
  await card.getByRole('button', { name: '编辑' }).click();
  await expect(form.getByLabel(/签名密钥/)).toHaveValue('journey-secret');
  await expect(issueActions.getByLabel('新建', {exact: true})).toBeChecked();
  await expect(prActions.getByLabel('合并', {exact: true})).toBeChecked();
  expect(await overflow()).toBe(true);
  await form.screenshot({ path: testInfo.outputPath('forward-form-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await overflow()).toBe(true);
  await form.screenshot({ path: testInfo.outputPath('forward-form-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  // Deselecting a type retains its local choices but must not submit its actions.
  await form.getByLabel('合并请求（PR）', {exact: true}).uncheck();
  await expect(prActions.locator('.forward-actions')).toBeHidden();
  await expect(prActions.getByLabel('合并', {exact: true})).toBeDisabled();
  await expect(form.getByLabel('标头值', { exact: true })).toHaveValue('Bearer crsr_journey');
  await form.getByLabel('显示标头值').check();
  await expect(form.getByLabel('标头值', { exact: true })).toHaveAttribute('type', 'text');
  await form.getByLabel('推送', { exact: true }).check();
  await form.getByRole('button', { name: '保存订阅' }).click();
  await expect(card.locator('.routes')).toContainText('推送');
  await expect(card.locator('.routes')).not.toContainText('合并请求（PR）');
  const updated = await (await page.request.get('/admin/api/forwards')).json();
  expect(updated.subscriptions.find(sub => sub.name === 'Issue 转发').actions).toEqual(['issue:opened']);
  await card.getByRole('button', { name: '编辑' }).click();
  await expect(issueActions.getByLabel('新建', {exact: true})).toBeChecked();
  await expect(prActions.getByLabel('合并', {exact: true})).not.toBeChecked();
  await issueActions.getByLabel('新建', {exact: true}).uncheck();
  await form.getByRole('button', {name: '保存订阅'}).click();
  await expect(card).toContainText('动作：各类型全部');
  expect(await overflow()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('forward-list-mobile.png'), fullPage: true });

  // The test button sends one marked request right away (this target answers 503 with no body);
  // the outcome and the call history appear on the card without reloading the list.
  const testing = reads.length;
  await card.getByRole('button', { name: '测试', exact: true }).click();
  await expect(card.locator('.test-result')).toContainText('测试结果：HTTP 503');
  await expect(card.locator('.test-result')).toContainText(/\d+ ms/);
  await expect(card.locator('.test-result')).toContainText('返回内容为空');
  await expect(card.locator('header')).toContainText('最近失败');
  expect(reads.slice(testing)).toEqual([expect.stringMatching(/^POST \/admin\/api\/forwards\/[0-9a-f-]{36}\/test$/)]);
  const history = card.locator('details');
  await history.locator('summary').click();
  await expect(history.locator('summary')).toHaveText('最近 1 次调用（最多保留 20 次）');
  await expect(history.locator('li')).toHaveCount(1);
  await expect(history.locator('li')).toContainText('ping');
  await expect(history.locator('li')).toContainText('测试');
  // A second test adds a row and keeps the opened history open.
  await card.getByRole('button', { name: '测试', exact: true }).click();
  await expect(history.locator('li')).toHaveCount(2);
  await expect(history).toHaveAttribute('open', '');
  expect(await overflow()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('forward-test-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await overflow()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('forward-test-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // A certificate client: the private key is refused, the certificate alone is stored.
  const pair = makeCertificate({ type: 'ec', cn: 'journey caller' });
  await page.getByRole('link', { name: '外部调用', exact: true }).click();
  await expect(page.locator('#caller-help')).toContainText('sdbot:caller');
  await page.getByRole('button', { name: '新增客户端' }).click();
  const callerForm = page.locator('#caller-form');
  await callerForm.getByLabel('名称').fill('评论机器人');
  await callerForm.getByLabel(/公钥证书/).fill(pair.certificate + pair.privateKeyPem);
  await callerForm.getByRole('button', { name: '保存客户端' }).click();
  await expect(callerForm.locator('.form-error')).toContainText('private key');
  await callerForm.getByLabel(/公钥证书/).fill(pair.certificate);
  // There is no operation list any more: a client exchanges tokens for its repositories.
  await expect(callerForm.locator('input[type=checkbox]')).toHaveCount(0);
  await callerForm.getByLabel(/允许的仓库/).fill('ScienceDiscovery/sciencediscovery');
  // Each permission has its name, what it allows, and 读写 / 只读 / 禁止; a new client starts with Issues and PR write.
  const perm = (form, key) => form.locator(`[data-perm="${key}"]`);
  await expect(callerForm.locator('.perm-row')).toHaveCount(12);
  await expect(perm(callerForm, 'contents').locator('.perm-desc')).toContainText('推送提交');
  for (const [key, level] of [['metadata', '只读'], ['contents', '禁止'], ['issues', '读写'], ['pull_requests', '读写'], ['workflows', '禁止']])
    await expect(perm(callerForm, key).getByLabel(level, { exact: true })).toBeChecked();
  await expect(perm(callerForm, 'metadata').getByLabel('禁止', { exact: true })).toBeDisabled();
  await expect(perm(callerForm, 'workflows').getByLabel('只读', { exact: true })).toBeDisabled();
  await perm(callerForm, 'contents').getByLabel('只读', { exact: true }).check();
  await perm(callerForm, 'issues').getByLabel('禁止', { exact: true }).check();
  await perm(callerForm, 'checks').getByLabel('读写', { exact: true }).check();
  expect(await overflow()).toBe(true);
  await callerForm.screenshot({ path: testInfo.outputPath('caller-permissions-mobile.png') });
  await callerForm.getByRole('button', { name: '保存客户端' }).click();
  await expect(callerForm).toBeHidden();
  const client = page.locator('#caller-list article', { hasText: '评论机器人' });
  await expect(client).toContainText('ES256');
  await expect(client).toContainText('证书有效');
  await expect(client).toContainText('sciencediscovery/sciencediscovery');
  await expect(client.locator('code').first()).toHaveText(/^[0-9a-f-]{36}$/);
  await expect(client).toContainText('令牌权限：metadata 只读 · contents 只读 · pull_requests 读写 · checks 读写');
  // Editing shows the saved choice again.
  await client.getByRole('button', { name: '编辑' }).click();
  await expect(perm(callerForm, 'issues').getByLabel('禁止', { exact: true })).toBeChecked();
  await callerForm.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('#token-grants')).toContainText('还没有发出过令牌');
  // The client exchanges a JWT for a token; refreshing the page lists it without the token itself.
  const { SignJWT } = await import('jose');
  const id = await client.locator('code').first().textContent();
  const assertion = await new SignJWT({ jti: crypto.randomUUID() }).setProtectedHeader({ alg: 'ES256' }).setIssuer(id).setSubject(id)
    .setAudience('sdbot:caller').setIssuedAt().setExpirationTime('2m').sign(pair.privateKey);
  const exchanged = await request.post('/caller/v1/token', { data: { repo: 'ScienceDiscovery/sciencediscovery' }, headers: { authorization: 'Bearer ' + assertion } });
  expect(exchanged.status()).toBe(200);
  const tokenBody = await exchanged.json();
  expect(tokenBody.token).toBe('ghs_browser-journey');
  expect(tokenBody.permissions).toEqual({ metadata: 'read', contents: 'read', pull_requests: 'write', checks: 'write' });
  await page.getByRole('button', { name: '刷新外部调用' }).click();
  const issued = page.locator('#token-grants tr', { hasText: 'ScienceDiscovery/sciencediscovery' });
  await expect(issued).toContainText('caller');
  await expect(issued).toContainText('评论机器人');
  await expect(issued).toContainText('有效');
  await expect(issued).toContainText('metadata:read, contents:read, pull_requests:write, checks:write');
  await expect(page.locator('#token-grants')).not.toContainText('ghs_');
  expect(await overflow()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('callers-mobile.png'), fullPage: true });

  // GitHub Actions access rules: none yet, then one workflow with two tokens of its own.
  const rules = page.locator('#actions-rules');
  await expect(rules).toContainText('还没有 GitHub Actions 访问规则');
  await page.getByRole('button', { name: '新增规则' }).click();
  const ruleForm = page.locator('#actions-rule-form'), grants = ruleForm.locator('.actions-grant');
  await ruleForm.getByLabel('名称').fill('看板采集');
  await ruleForm.getByLabel(/工作流所在仓库/).fill('sciencediscovery/github-status-board');
  // 校验 reads the IDs right away and puts GitHub's spelling of the name in the field.
  const workflowCheck = ruleForm.locator('.repo-check').first();
  await workflowCheck.getByRole('button', { name: '校验' }).click();
  await expect(workflowCheck.locator('.check-result')).toHaveText('✓ ScienceDiscovery/github-status-board · 仓库 ID 900 · 所有者 ID 901 · GitHub App 已安装');
  await expect(ruleForm.getByLabel(/工作流所在仓库/)).toHaveValue('ScienceDiscovery/github-status-board');
  await ruleForm.getByLabel('工作流文件', { exact: true }).fill('.github/workflows/collect.yml');
  await expect(ruleForm.getByLabel('分支')).toHaveValue('main');
  await expect(ruleForm.getByLabel(/workflow_dispatch/)).toBeChecked();
  await ruleForm.getByLabel(/定时（schedule）/).check();
  await expect(ruleForm.locator('#actions-rule-events')).not.toContainText('pull_request');
  await grants.first().getByLabel(/用途名/).fill('source');
  // A misspelled repository is caught before saving.
  await grants.first().getByLabel(/目标仓库/).fill('ScienceDiscovery/sciencediscovry');
  await grants.first().getByRole('button', { name: '校验' }).click();
  await expect(grants.first().locator('.check-result')).toContainText('校验失败：GitHub 上读不到这个仓库');
  await grants.first().getByLabel(/目标仓库/).fill('ScienceDiscovery/sciencediscovery');
  await expect(grants.first().locator('.check-result')).toBeHidden();
  await perm(grants.first(), 'issues').getByLabel('只读', { exact: true }).check();
  await ruleForm.getByRole('button', { name: '添加令牌' }).click();
  await expect(grants).toHaveCount(2);
  // The second token leaves its purpose empty: it answers any purpose.
  await expect(grants.last().getByLabel(/用途名/)).toHaveValue('');
  await grants.last().getByLabel(/目标仓库/).fill('ScienceDiscovery/github-status-board');
  await grants.last().getByRole('button', { name: '校验' }).click();
  await expect(grants.last().locator('.check-result')).toContainText('GitHub App 已安装');
  await perm(grants.last(), 'contents').getByLabel('读写', { exact: true }).check();
  expect(await overflow()).toBe(true);
  await ruleForm.screenshot({ path: testInfo.outputPath('actions-rule-mobile.png') });
  await ruleForm.getByRole('button', { name: '保存规则' }).click();
  await expect(ruleForm).toBeHidden();
  // The workflow repository is pinned by the IDs GitHub reports, under GitHub's spelling.
  const ruleCard = rules.locator('article', { hasText: '看板采集' });
  await expect(ruleCard).toContainText('工作流：ScienceDiscovery/github-status-board 的 .github/workflows/collect.yml，分支 main');
  await expect(ruleCard).toContainText('仓库 ID 900 · 所有者 ID 901');
  await expect(ruleCard).toContainText('schedule、workflow_dispatch');
  await expect(ruleCard).toContainText('令牌 source → ScienceDiscovery/sciencediscovery：metadata 只读 · contents 只读 · issues 只读');
  await expect(ruleCard).toContainText('令牌（任意 purpose） → ScienceDiscovery/github-status-board：metadata 只读 · contents 读写');
  await expect(page.locator('#actions-count')).toHaveText('1 / 20 条规则');
  // A refused save says why; removing a token then applies.
  await ruleCard.getByRole('button', { name: '编辑' }).click();
  await ruleForm.getByLabel('工作流文件', { exact: true }).fill('collect.yml');
  await ruleForm.getByRole('button', { name: '保存规则' }).click();
  await expect(ruleForm.locator('.form-error')).toContainText('.github/workflows');
  await ruleForm.getByLabel('工作流文件', { exact: true }).fill('.github/workflows/collect.yml');
  await grants.first().getByRole('button', { name: '删除这个令牌' }).click();
  await expect(grants).toHaveCount(1);
  await ruleForm.getByRole('button', { name: '保存规则' }).click();
  await expect(ruleForm).toBeHidden();
  await expect(ruleCard).not.toContainText('令牌 source');
  await expect(ruleCard).toContainText('令牌（任意 purpose）');
  await page.setViewportSize({ width: 1280, height: 900 });
  await ruleCard.getByRole('button', { name: '编辑' }).click();
  await ruleForm.screenshot({ path: testInfo.outputPath('actions-rule-desktop.png') });
  await ruleForm.getByRole('button', { name: '取消' }).click();
  await ruleCard.getByRole('button', { name: '删除' }).click();
  await expect(rules).toContainText('还没有 GitHub Actions 访问规则');
  await page.setViewportSize({ width: 1280, height: 900 });
  await client.getByRole('button', { name: '编辑' }).click();
  await callerForm.screenshot({ path: testInfo.outputPath('caller-permissions-desktop.png') });
  await callerForm.getByRole('button', { name: '取消' }).click();
  await page.setViewportSize({ width: 390, height: 844 });

  // Nothing is read on a timer once the page has loaded.
  const before = reads.length;
  await page.clock.runFor(20 * 60_000);
  await page.waitForTimeout(500);
  expect(reads.slice(before)).toEqual([]);

  await client.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('#caller-list')).toContainText('还没有外部调用客户端');
  await page.getByRole('link', { name: '转发', exact: true }).click();
  await card.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('#forward-list')).toContainText('还没有转发订阅');
});

test('a failed read says whether to wait for a new version or to log in again', async ({ page, context }) => {
  await context.addCookies([{ name: 'test_access', value: 'allowed', url: 'http://127.0.0.1:18893', httpOnly: true }]);
  const banner = page.locator('#banner');
  // Right after a deployment: the Worker says retrying soon helps.
  await page.route('**/admin/api/status', route => route.fulfill({ status: 503, json: { ok: false, error: 'the bot is switching to a new version; retry in a minute', retryable: true } }));
  await page.goto('/admin/#events');
  await expect(banner).toHaveText('读取失败：Bot 正在切换到新版本，约一分钟后刷新页面即可');
  // Any other 503 is temporary too, and not a login problem.
  await page.unroute('**/admin/api/status');
  await page.route('**/admin/api/status', route => route.fulfill({ status: 503, json: { ok: false, error: 'service unavailable' } }));
  await page.reload();
  await expect(banner).toHaveText('读取失败：服务暂时不可用（service unavailable），可能正在发布新版本，请稍后刷新');
  await expect(banner).not.toContainText('登录');
  // Only an Access refusal points to logging in again.
  await page.unroute('**/admin/api/status');
  await page.route('**/admin/api/status', route => route.fulfill({ status: 401, json: { ok: false, error: 'unauthorized' } }));
  await page.reload();
  await expect(banner).toHaveText('读取失败：unauthorized（登录可能已过期，请刷新页面重新登录）');
});

test('relay signature modes match a GitHub-compatible receiver and archived events can be forwarded again', async ({page, context, request}, testInfo) => {
  await context.addCookies([{name:'test_access',value:'allowed',url:'http://127.0.0.1:18893',httpOnly:true}]);
  await page.goto('/admin/#forwards');
  await page.getByRole('button',{name:'新增订阅'}).click();
  const form=page.locator('#forward-form');
  await expect(form.getByLabel('保留来源签名',{exact:true})).toBeChecked();
  await form.getByLabel('名称',{exact:true}).fill('标准签名验收');
  await form.getByLabel('目标 URL').fill('https://signatures.example/hook');
  await form.getByLabel('议题（Issue）',{exact:true}).check();
  await form.getByRole('button',{name:'生成密钥',exact:true}).click();
  await expect(form.getByLabel(/签名密钥/)).toHaveValue(/^whsec_[A-Za-z0-9+/]{43}=$/);
  await form.getByLabel(/签名密钥/).fill('journey-standard-secret');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await form.screenshot({path:testInfo.outputPath('signature-mode-mobile.png')});
  await form.getByRole('button',{name:'保存订阅'}).click();
  const card=page.locator('#forward-list article',{hasText:'标准签名验收'});
  await expect(card).toContainText('保留来源签名');
  // This receiver only accepts GitHub-style signatures: preserve now fails the sample as real GitHub would.
  await card.getByRole('button',{name:'测试',exact:true}).click();
  await expect(card.locator('.test-result')).toContainText('HTTP 401');
  await expect(card.locator('.test-result')).toContainText('"standard":true');
  await expect(card.locator('.test-result')).toContainText('"github_compatible":false');
  await card.getByRole('button',{name:'编辑'}).click();
  await expect(form.getByLabel('GitHub 兼容',{exact:true}).locator('..')).toHaveAttribute('title',/只支持 GitHub/);
  await form.getByLabel('GitHub 兼容',{exact:true}).check();
  await form.getByRole('button',{name:'保存订阅'}).click();
  await card.getByRole('button',{name:'测试',exact:true}).click();
  await expect(card.locator('.test-result')).toContainText('HTTP 202');
  await expect(card.locator('.test-result')).toContainText('"upstream_preserved":true');
  await page.setViewportSize({width:1440,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await card.screenshot({path:testInfo.outputPath('signature-receiver-desktop.png')});
  const delivery=randomUUID(), body=JSON.stringify({action:'opened',repository:{full_name:'ScienceDiscovery/sciencediscovery'},issue:{number:21,title:'重新转发验收'}});
  expect((await request.post('/webhook/github',{data:body,headers:{'content-type':'application/json','x-github-event':'issues','x-github-delivery':delivery,
    'x-hub-signature-256':'sha256='+createHmac('sha256',process.env.SDBOT_E2E_SECRET).update(body).digest('hex')}})).status()).toBe(200);
  await page.getByRole('link',{name:'事件记录',exact:true}).click();
  await page.locator('#f-delivery').fill(delivery);await page.locator('#f-delivery').press('Enter');
  await expect(page.locator('#rows tr')).toHaveCount(1);
  await page.locator('#rows tr').filter({hasText:'重新转发验收'}).getByRole('button',{name:'查看详情'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.locator('#request-body')).toContainText('重新转发验收');
  await dialog.getByRole('button',{name:'重新转发',exact:true}).click();
  await expect(dialog.locator('#forward-archived-result')).toContainText(/已向 \d+ 个订阅安排重新转发，投递 manual-/);
  await dialog.screenshot({path:testInfo.outputPath('manual-forward-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await dialog.screenshot({path:testInfo.outputPath('manual-forward-mobile.png')});
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('link',{name:'转发',exact:true}).click();
  await expect(card).toContainText('最近成功');
  await card.locator('details summary').click();
  await expect(card.locator('.forward-history')).toContainText('manual-');
  await expect(card.locator('.forward-history')).toContainText('第 1 次');
  await expect(card.locator('.forward-history')).toContainText('issue');
  // Removing this fixture subscription cancels any of its pending work, and keeps later runs isolated.
  await page.evaluate(()=>window.confirm=()=>true);
  await card.getByRole('button',{name:'删除',exact:true}).click();
  await expect(card).toHaveCount(0);
});
