# 云端只读管理

## 功能与入口

接收与管理共用一个 Worker。`/admin`、`/admin/` 是管理页面，`/admin/api/status`、`/admin/api/listeners`、`/admin/api/events`、`/admin/api/events/<record_id>` 及 `/admin/api/usage` 是只读接口。唯一的管理写接口是 `/admin/api/forwards` 与 `/admin/api/callers`（及其 `/<id>`），用于配置 [Webhook 转发](webhook-forwarding.md) 和 [外部调用](caller-api.md)；它们同样先经过 Access 校验，并只接受同源 JSON 写入。页面复用事件详情、筛选、分页、浏览器时区和实际监听点列表；顶栏标明运行环境与云端记录。

所有管理页面与 API 均要求 Cloudflare Access 身份。根路径 `/api/status` 等不提供别名，Webhook 与健康路径不要求交互登录。Node 的本机管理端继续使用原有 Bearer／loopback／Cf-* 拒绝规则，本地管理桥不进入云端部署产物。

正式 Worker 已部署这套页面并配置 Access 应用与 issuer／AUD，指定成员登录后查询本实例已保存的云端投递。原测试 Worker 已删除，不再有测试管理页。

管理重放按钮及 `POST /api/replay/<record_id>` 已移除。除上述转发与外部调用配置接口外，云端管理写方法返回 405，Node 已删除端点返回 404；查询不会执行监听器、增加投递或调度刷新。需要重新采集时使用看板仓 Actions。开发 fixture CLI 不属于管理重放，仍可用于隔离测试。

## Access 配置

1. 在 Cloudflare Zero Trust 创建 self-hosted Access 应用，保护接收域名的 `/admin` 及所有 `/admin/*` 路径。只允许指定成员登录；不要把整个接收域名配置为需要登录，否则 GitHub 无法投递，Actions 也无法使用 OIDC 兑换令牌。`/actions/token` 由 Worker 自行校验 GitHub OIDC，不要求浏览器 Access 登录。
2. 在对应 Wrangler 配置的 `vars` 中设置 `SDBOT_ACCESS_ISSUER=https://<team>.cloudflareaccess.com`、`SDBOT_ACCESS_AUD=<application-aud>` 和 `SDBOT_ADMIN_HOSTNAME=<管理所在域名>`。issuer 不带尾部斜杠，AUD 为对应 Access 应用的标识；这些不是私钥。
3. 部署后验证未认证访问被拦截，指定成员登录后可打开 `/admin/`、查询真实云端记录。确认 `/webhook/github` 的签名请求不受登录限制，`/api/status` 仍为 404。

参数缺失时 `/admin` 返回 503 `admin unavailable`，不会自动降级为匿名或旧本机口令认证。参数齐全但无效身份为 401；Access 本身可能先返回登录页面。浏览器不保存 App 私钥或管理员 API token。

Worker 用 jose 验证 RS256 签名、固定 issuer、AUD、有效期与主体，JWKS 只从固定团队域名读取并短期缓存；不跟随重定向，验证失败不输出令牌或上游正文。不信任客户端自报的邮箱／角色 Header。管理响应禁止缓存，页面禁止框架嵌入，Webhook 正文仅作为文本显示。

参考：[Access 路径规则](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)、[JWT 校验](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

## 部署实例

云端只有正式 Worker `sciencediscovery-bot`，配置是 `wrangler.jsonc`，由 `main` 分支经 Workers Builds 发布：正式源仓 → 正式看板，Cron 每五分钟，使用独立归档桶与对象命名空间。原测试 Worker、测试域名和测试存储已删除，仓库也不再保留测试配置；不要重建测试实例。

`npm run workers:check` 只对 `wrangler.jsonc` 做本地 dry-run，不创建远端资源。日常发布经 Workers Builds 完成，见 [Worker 自动部署](worker-delivery.md)；手动 `npx wrangler deploy -c wrangler.jsonc` 只作维护入口，执行前确认当前登录账号、私有 bucket、Secrets 与调度范围。配置里声明 bucket 不代表它已经在账号创建。

同一实例内管理和接收共享发布与存储资源；改动在合入前用本地 workerd 测试和浏览器旅程验证。管理分页限制单次工作量，详情按需读正文；不在接收互斥区内运行大批历史扫描。

## 历史与切换

云端面板仅查询该实例接收的真实投递，不读取本地模拟存储和原 Compose 数据卷。旧 Webhook 档案不迁移，原卷保留用于本机历史查询；不在云端伪造旧记录。R2 保存的应用响应与客户端实际网络响应可能不同，缺失信息不补造。

看板 Actions 从 GitHub API 读取事实，进度、历史记录和测试指标保存在各看板仓 `.sync/` 与 `site/`，切换 Bot 不重置这些目录。旧档案不迁移不会减少已保存的看板历史；上游已过期、从未采集到的报告仍无法恢复。其余仓库的新 Webhook 继续归档，业务仅处理允许范围。

正式切换先确认新版本的签名接收、云端存档和 Actions 链路，再移交调度与 App Webhook URL。普通仓库 Webhook 的旧地址也要核对。核对在途 Actions，避免同站同时被两套 Bot 常驻调度；最后停止 Compose 的 bot 与 cloudflared，保留数据卷。管理登录可以在接收切换后单独开通，期间管理端保持关闭，归档持续保存。回退先将 Worker 看板目标设为空并关闭 Cron，再恢复旧服务与地址，不并行启用两套常驻刷新。

## 实现与验证

`src/worker/access.ts` 完成身份验证；外层 Worker 认证后通过只读 `BotObject.query()` 调用共享 `BotApplication.readAdmin()`。认证不依赖外部请求选择内部任意方法。管理页面作为 Text 模块打包，仍使用同一份 `static/index.html`。

验证：`tests-ts/cloud-admin.test.mjs` 在真实 workerd 中检查身份、固定路径、只读、签名投递和存档；`npm run test:e2e:cloud-admin` 使用本地测试 Access 代理验证桌面／窄屏页面，不连接线上。完整命令与边界见[验证指南](../testing.md)。
