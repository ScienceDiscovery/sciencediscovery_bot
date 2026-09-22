# 管理面板

## 两个页面

本机管理端默认 `http://127.0.0.1:8792/`，顶栏切换“事件记录”和“监听点”。直接访问 `/#subscriptions` 可打开监听页；回到事件页保留当前筛选和翻页状态。

事件页显示验签配置、投递计数、跟踪仓、静态看板各目标状态和投递列表。可按事件种类、状态、route、number 过滤，浏览全部历史，查看请求／响应和重放。自动刷新间隔为 10 秒，浏览历史分页时暂停事件自动刷新。两套静态看板分别显示待更新／发布中／最近成功状态。

Workers 本地模拟器使用同一面板，默认管理地址为 `http://127.0.0.1:18892/`。看板状态为 `execution=github_actions` 时显示“触发采集中／已触发采集”和最近触发时间，不把 Actions 接受请求说成 Pages 发布成功；没有密钥的平台显示“未启用此平台接入”。事件页在窄屏自动换行，只有宽表格在自己的容器横向滚动。该管理端只读写模拟存储，不能查询现有 Compose 或云端档案；部署 bundle 不包含本地管理桥，见 [Workers 指南](workers.md)。

监听点页来自运行进程的实际注册表，展示稳定 ID、所属业务、用途、订阅／排除事件、平台／仓库范围及状态。支持业务、状态筛选和文字搜索；空结果有明确提示。已启用表示执行业务；占位表示只记录调用；已停用表示注册存在但不调用。监听点与来源平台的订阅不同：在这里注册不会自动修改 GitHub App 权限或订阅。

面板仅提供查看监听清单，不支持在线修改监听器。全局范围检查在监听条件之前执行。来源外的记录不会因为业务使用通配符而被处理。

## 访问边界

公开 webhook 端口不会暴露这些页面或 API。管理端默认绑定 loopback；容器只发布到宿主 127.0.0.1。带任意 Cf-* 头的管理请求拒绝，隧道不可转发此端口。

配置 SDBOT_ADMIN_TOKEN 后，静态外壳仍可打开，数据接口和管理健康接口要求 Bearer。可先访问 `/#token=<URL 编码的口令>`；脚本取出片段后从地址栏移除，仅保存在当前页面内存中。切换页保留该内存，整页重载后需再次提供口令；不能使用 URL 查询参数传口令。

## API

| 方法与路径 | 返回／用途 |
| --- | --- |
| GET /healthz | 管理健康与 uptime |
| GET /api/status | 无密钥的配置视图、计数、最近记录、board.targets 发布状态 |
| GET /api/listeners | listeners 实际注册清单、repositories 全局处理范围；不包含回调对象和密钥 |
| GET /api/events | 投递摘要、offset、has_more；limit 默认 50、上限 500 |
| GET /api/events/<record_id> | 指定投递的请求／实际响应、完整性与历史兼容信息 |
| POST /api/replay/<record_id> | 用新 delivery_id 重放完整正文，见[投递记录](webhook-history.md) |

事件查询支持 kind、route、repo、number、status、provider、action、delivery_id、offset、limit。页面时间使用浏览器时区，自动处理夏令时；原始正文不变。

实现：`src/core/http.ts`、`src/node/server.ts`、`static/index.html`。监听 API 直接读取 `router.bus.inventory()`，没有第二份静态监听清单。验证：`tests-ts/archive-http.test.ts` 和 `test/journey-*.spec.cjs` 的真实浏览器测试。
