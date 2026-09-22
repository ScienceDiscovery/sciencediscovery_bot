const {test, expect}=require('../.e2e/node_modules/@playwright/test');
const auth=()=>({Authorization:'Bearer '+process.env.SDBOT_E2E_ADMIN_TOKEN});

test('actual listeners are discoverable, searchable, and remain private',async({page,request},testInfo)=>{
  const inventory=await (await request.get('/api/listeners',{headers:auth()})).json();
  expect(inventory.listeners).toHaveLength(11);
  expect((await request.get('/api/listeners')).status()).toBe(401);
  expect((await request.get('/api/listeners',{headers:{...auth(),'Cf-Ray':'test'}})).status()).toBe(403);
  expect((await request.get('http://127.0.0.1:18891/api/listeners')).status()).toBe(404);
  await page.goto('/#token='+process.env.SDBOT_E2E_ADMIN_TOKEN);
  await page.getByRole('link',{name:'监听点',exact:true}).click();
  await expect(page.locator('.subscription')).toHaveCount(inventory.listeners.length);
  for(const listener of inventory.listeners) await expect(page.getByRole('heading',{name:listener.id,exact:true})).toBeVisible();
  await expect(page.locator('#subscription-scope')).toContainText('openjiuwen-ai/sciencediscovery');
  await expect(page.locator('#subscription-scope')).toContainText('sciencediscovery/sciencediscovery');
  await page.locator('#subscription-business').selectOption('看板更新');
  await expect(page.locator('.subscription')).toHaveCount(6);
  await expect(page.locator('#subscription-list')).toContainText('未启用静态发布');
  await page.locator('#subscription-search').fill('merged');
  await expect(page.locator('.subscription')).toHaveCount(1);
  await expect(page.locator('#subscription-list')).toContainText('board.on_pull_request_merged');
  await page.locator('#subscription-search').fill('nothing-matches');
  await expect(page.locator('#subscription-list')).toHaveText('没有匹配的监听点');
  await page.locator('#subscription-search').clear();
  await page.screenshot({path:testInfo.outputPath('listeners-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:testInfo.outputPath('listeners-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('link',{name:'事件记录',exact:true}).click();
  await expect(page.locator('#events-page')).toBeVisible();
  await expect(page.locator('#subscriptions-page')).toBeHidden();
  await page.getByRole('link',{name:'监听点',exact:true}).click();
  await expect(page.locator('.subscription')).toHaveCount(6);
  await expect(page.locator('#banner')).toBeHidden();
  expect(page.url()).not.toContain(process.env.SDBOT_E2E_ADMIN_TOKEN);
});

test('enabled, placeholder and disabled listeners are distinct and safely rendered',async({page})=>{
  const listeners=[
    {id:'notify.open',business:'通知',description:'Issue 新建通知',mode:'active',enabled:true},
    {id:'analyze.issue',business:'分析',description:'尚未启用分析',mode:'noop',enabled:true},
    {id:'archive.custom',business:'归档',description:'<img src=x onerror="window.executed=true">',mode:'disabled',enabled:false}
  ].map(row=>({...row,routes:['issue.opened'],exclude:[],providers:['github'],repositories:['example/source']}));
  await page.route('**/api/listeners',r=>r.fulfill({json:{ok:true,listeners,repositories:['example/source']}}));
  await page.goto('/#token='+process.env.SDBOT_E2E_ADMIN_TOKEN);
  await page.getByRole('link',{name:'监听点',exact:true}).click();
  await expect(page.locator('.subscription')).toHaveCount(3);
  expect(await page.locator('.subscription img').count()).toBe(0);
  for(const mode of ['active','noop','disabled']) {
    await page.locator('#subscription-mode').selectOption(mode);
    await expect(page.locator('.subscription')).toHaveCount(1);
    await expect(page.locator('.subscription')).toContainText(listeners.find(l=>l.mode===mode).id);
  }
  expect(await page.evaluate(()=>window.executed)).toBeUndefined();
  await page.route('**/api/listeners',r=>r.fulfill({status:503,json:{error:'temporary failure'}}));
  await page.getByRole('button',{name:'刷新监听点'}).click();
  await expect(page.locator('#banner')).toContainText('temporary failure');
  await expect(page.locator('.subscription')).toHaveCount(1);
});

test('two publication targets are displayed independently on the events page',async({page})=>{
  await page.route('**/api/status',async route=>{
    const response=await route.fetch(), doc=await response.json();
    doc.board={enabled:true,targets:[
      {source:'prod/source',repository:'example/production-board',running:true,pending:true,last_success:null},
      {source:'test/source',repository:'example/test-board',running:false,pending:true,last_success:null,error:'RuntimeError'}
    ]};
    await route.fulfill({response,json:doc});
  });
  await page.goto('/#token='+process.env.SDBOT_E2E_ADMIN_TOKEN);
  const production=page.locator('.card').filter({hasText:'example/production-board'});
  const experiment=page.locator('.card').filter({hasText:'example/test-board'});
  await expect(production).toContainText('发布中');
  await expect(experiment).toContainText('等待更新');
  await expect(experiment).toContainText('RuntimeError');
  await expect(page.locator('#cards')).not.toContainText('undefined');
});
