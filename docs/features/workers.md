# Workers 运行适配与 Actions 采集

## 功能与边界

Worker 保留 Webhook 验签、事件总线、配置的源仓范围、全量投递存档与最小公开响应；看板采集由目标看板仓的 GitHub Actions 执行，Python 采集器继续使用。无需在 Worker 内启动 Python，也不依赖 cloudflared。

Bot 代码随 GitHub 提交自动部署的接入方案见 [Worker 自动部署](worker-delivery.md)，可选择 Cloudflare Workers Builds 或 Bot 仓 GitHub Actions。下文的看板 Actions 负责数据采集，不负责部署 Bot。

现有正式服务使用 `wrangler.jsonc`，App Webhook URL 使用正式接收域名下的 `/webhook/github`。该实例仅将 `openJiuwen-ai/sciencediscovery` 映射到 `ScienceDiscovery/github-status-board`，启用持久 Alarm 与每五分钟的修复 Cron。本地 Compose 的 bot 与 cloudflared 已停止，数据卷保留；不要为查看旧档案直接恢复带看板调度的整套服务。

独立测试实例使用 `wrangler.test.jsonc`，接收地址使用独立测试域名下的 `/webhook/github`。它使用自己的 SQLite Durable Object、私有 R2、测试 App 与 Webhook secret；只允许实验源仓，唯一目标为 `ScienceDiscovery/sciencediscovery` → `ScienceDiscovery/github-status-board-test`。测试配置启用持久 Alarm 和每五分钟修复 Cron，须在测试 App 安装到实验源仓及测试看板仓、云端 Secrets 和看板 Actions 凭据验证通过后部署。测试看板通过 OIDC 向测试 Worker 兑换临时凭据，工作流不再保存测试 App 私钥。

两个实例均提供最小健康检查 `/healthz`。同域名的 `/admin/` 已随代码部署，但目前尚未配置 Access 应用与 issuer／AUD，返回 503 `admin unavailable`，不能登录查询；这不影响 Webhook 接收与云端存档。开通步骤见[云端只读管理](cloud-admin.md)。App ID 是非敏感配置，密钥单独保存在云端 Secrets。部署到另一账号时应替换 App ID、域名及资源名称；首次部署先按下文关闭调度和 routes，不能照搬正式启用配置。

本地适配使用真实 workerd、SQLite Durable Object 和 R2 模拟存储，可验证重启恢复、查询、去重与调度。本地命令不会创建账号资源或切换云端服务；本地模拟器既不读取 Compose 的 `.env`，也不读取其历史数据。

```text
GitHub / GitCode → Worker → BotObject（同一具名实例）
                              ├─ R2：私有正文、请求与响应
                              ├─ SQLite：索引、去重、待刷新状态
                              └─ Alarm → GitHub App → 目标仓 collect.yml
                                                         ↓ Python 采集
                                                       main/site/
                                                         ↓ pages.yml
                                                       GitHub Pages
```

## 本地运行

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run workers:local
```

默认公开入口 `http://127.0.0.1:18891/webhook/github`，管理页 `http://127.0.0.1:18892/`。示例包含一次性用途的本地测试值；管理页填入 `.dev.vars` 中的 `SDBOT_ADMIN_TOKEN`。不要复制生产 `.env` 到测试配置。`--env`、`--state`、`--port`、`--admin-port` 可覆盖测试配置、状态目录和两个 loopback 端口。

SQLite、R2 模拟数据及运行时文件保存在 `.wrangler/local/`，正常 Ctrl-C 后保留，下次启动可继续查询。清空这个目录会丢失本地模拟投递，不能用它替代生产备份。

默认阻止所有出站网络；不会因误填 App 凭据触发远端工作流。只有显式加 `--allow-github` 才允许访问 `https://api.github.com`。启用该参数属于真实远端操作，不是离线验收步骤。查看回放完整链路的离线验证用 `npm run test:worker-adapter`，测试生成临时 RSA 密钥并模拟 GitHub 响应。

## 主要实现

- `src/worker/index.ts`：公开 Fetch、Access 鉴权管理、Cron 与 `BotObject`。所有投递都进入固定名称 `archive-v1`，避免多个 Worker 实例各自去重。管理路径通过 Access JWT 校验后仅可调用只读 RPC；未认证路径不会转入管理方法。
- `src/worker/archive.ts`：完整正文和包含请求／应用响应的详情先写 R2，随后用 SQLite 事务写查询索引、计数、delivery 去重和待刷新状态。存储失败返回 503，不确认成功；失败前写入的 R2 对象可能成为未索引对象，后续维护不能只按日期随意清理。
- `src/worker/board.ts`：订阅处理器暂存本次刷新意图，只有归档事务成功才计入 `requested`。同仓短时间事件合并，默认 20 秒去抖、成功触发间隔至少 60 秒；正式实例设 `SDBOT_BOARD_DEBOUNCE=600`，10 分钟内的事件合并为一次采集，两次触发至少相隔 10 分钟，测试实例保留默认值便于验证；失败从 30 秒指数退避到 600 秒。发送前保存 120 秒执行租约，崩溃后恢复。Alarm 执行期间不阻塞新投递；正式实例每五分钟 Cron 修复调度，空闲站点默认每小时刷新一次。测试实例采用同样的调度规则，但只操作测试看板；停用任何环境时清空该环境的目标映射。
- `src/core/actions.ts`：只为目标看板仓申请 `Metadata: read / Actions: write` 安装令牌，调用固定 `collect.yml`、固定 `main`，传入源仓和刷新编号。私钥、令牌、原始 Webhook 内容不会作为工作流 inputs 传递。
- `tools/workers-local.mjs` 与 `src/worker/local-admin.ts`：本地管理桥和现有面板。校验 loopback hostname，并继续拒绝 Cf-* 头；公网 bundle 包含受认证保护的管理页面，不包含本地管理桥。

去重沿用最近 2000 个已接受 delivery 的窗口，可由 `SDBOT_DEDUPE_WINDOW` 调整；被去重的重复请求仍独立归档。窗口大小保存在 `counters` 计数行，新 delivery 超出窗口时按 `seq` 索引删除最旧的记录，每次只读取被删除的行，不再每次扫描整个窗口；旧存储首次加载时统计一次现有窗口大小。SQL 筛选索引字段最多 4096 字符，完整字段保存在 R2 详情中。只读查询／分页协议与 Node 管理端一致，旧文件归档不会自动导入这个新存储。

Actions 调用在网络断开或进程崩溃时可能重试；GitHub dispatch 接口没有本项目可依赖的去重键，因此不承诺远端任务恰好执行一次。采集是重新计算快照，目标仓 `concurrency` 串行执行，提交仍是非强制更新。工作流失败不会把旧页面删掉。

管理状态中 `execution=github_actions`、`dispatched`、`last_dispatch` 只表示 GitHub 已接受任务；`last_success` 与 `commit` 不虚构发布结果。面板显示“已触发采集”。采集结果和 Pages 发布结果分别查看目标仓的两个 Actions 工作流。调度只重试触发失败，已被 GitHub 接受后发生的采集失败由下一轮刷新／人工重跑恢复。

## 日志

正式与测试配置均开启 Workers Logs（`observability.logs.enabled` 与 `invocation_logs`），用于排查线上请求和 Durable Object 调用失败。代码本身不输出 `console` 日志，平台为每次调用记录请求方法、URL、响应状态、耗时和未捕获异常，不记录请求或响应正文。日志只在 Cloudflare 账号控制台可见，保留期由套餐决定。

平台会把 cookie 以及名称含 `auth`、`key`、`secret`、`token`、`jwt` 的请求头值替换为 `REDACTED`，因此 `/actions/token` 的 OIDC Bearer 凭据不会以明文进入日志。GitHub／GitCode 的 `x-*-signature-256` 不在平台脱敏范围，会按原值记录；签名只能核验对应那一次投递正文，不能推出 Webhook secret，而正文不进入日志。投递存档中的请求头仍由 `safeHeaders` 另行脱敏。Worker 顶层对未处理异常统一返回 503、不输出原因，排查时对照同一时刻 `BotObject` 的调用记录。[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[脱敏规则](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)

### 存储读取成本

Durable Objects 的 SQLite 按读取与写入的行数计量，免费额度按账号统计、每天 00:00 UTC 重置；额度用尽后所有 Durable Object 调用都会失败，Webhook、令牌兑换和健康检查均返回 503。因此热路径只做有索引的定点读写：去重窗口按上述计数淘汰，令牌兑换的过期清理使用 `credential_claims(expires)` 索引，只读取已过期的记录。在默认 2000 的窗口下实测每个动作的行数：

| 动作 | 读取 | 写入 |
| --- | --- | --- |
| 范围内 Webhook（已接受） | 8 | 11 |
| 范围外 Webhook（仅归档） | 1 | 7 |
| 一次令牌兑换（已有 2000 条有效记录） | 1 | 3 |

优化前后两项的读取分别约为 8000 行和 2000 行，随窗口或当日兑换次数增长。`tests-ts/worker-storage-cost.test.mjs` 限定这两条路径的读写上界。按免费额度，写入量（每天 10 万行）会先于读取量成为上限，约相当于每天 9000～14000 次投递。[计价与额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Actions 配置

两个看板仓都需要 `collect.yml`、`collection_context.py`、`collect_with_oidc.py` 和已有采集器代码。每个看板仓的 `board-config.json` 只保存本站映射，相同工作流按运行仓选择唯一源仓，拒绝另一个环境的目标或源仓；正式与测试快照不能互相覆盖。

正式与测试目标仓分别配置 `SDBOT_TOKEN_BROKER_URL` 和 `SDBOT_TOKEN_AUDIENCE` 两个 Actions Variables；私钥仅由对应 Worker 使用。`collect_with_oidc.py` 校验本站映射后，通过工作流 OIDC 身份换取源仓只读／目标仓 Contents 写令牌，采集后尝试撤销。Worker 同时固定看板仓／组织 ID、main 与 collect.yml；详见 [Actions OIDC](actions-oidc.md)。

源仓读取权限沿用看板要求：Contents、Issues、Pull requests、Actions、Checks、Commit statuses；目标仓需要 Contents 写与触发任务的 Actions 写权限。App 必须安装到两端，跨组织分别使用对应 installation。Actions 用 App 令牌提交 site，使已有 `pages.yml` 的 push 触发器生效；不能换成默认 GITHUB_TOKEN 写入后期待自动触发另一个工作流。

在 App 注册页 **Permissions & events → Repository permissions → Actions** 选择 **Read and write** 后，还需目标组织批准 installation 的新增权限。应检查目标仓 installation 返回的 `permissions.actions` 已是 `write`，不能只看注册页。此权限与仓库 Actions 设置中的默认 `GITHUB_TOKEN` 权限不同；后者可以保持只读，Pages 工作流按 job 声明所需权限。

验收分为三步：App 安装令牌成功触发 `collect.yml`；采集任务使用两个安装令牌读取源仓、原子提交目标仓 `.sync/` 与 `site/`；该 App 提交触发 `pages.yml` 并部署成功。管理员手动触发成功只能验证后两步。Node／Compose 可用 `SDBOT_BOARD_EXECUTION=github_actions` 切换为相同触发流程，无需先部署 Worker。Worker 接管 Webhook 仍需单独完成部署与接收切换；旧档案按既定方案保留，不迁移。

## 新账号首次上线步骤（本地验收不会执行）

前提：两个看板仓已有采集工作流、脚本及各自的 `.sync/` 与 `site/`；App 权限、Worker Secrets、OIDC 信任和看板仓变量已配置，并通过真实采集和 Pages 验收。更新共享源码时保留各站数据和独立功能，不重新初始化同步进度。

1. 在目标 Cloudflare 账号开通 R2，创建私有归档 bucket；名称与对应 Wrangler 配置的 `r2_buckets[].bucket_name` 一致。不启用公开域名或公开读取，不配置未经评估的自动删除规则。
2. 使用 `npx wrangler login --device` 授权部署工具，再用 `npx wrangler whoami` 核对账号；账号有多个时在配置中明确 `account_id`。Tunnel token 不能代替 Workers 部署授权。
3. 首次部署保持 `workers_dev=false`、`preview_urls=false`、无 routes、`triggers.crons=[]`、`SDBOT_BOARD_TARGETS="{}"`。执行 `npm run workers:check` 只做本地检查；`npx wrangler deploy` 才会实际创建／更新云端 Worker 与 SQLite Durable Object 命名空间。首次初始化之后不要随意改类名、迁移标签、Worker 名称或 `archive-v1`，以免指向另一份历史。该阶段没有公开入口或 Cron，不要求未配置 Secrets 的服务已经能处理请求。
4. 在 Worker 的 Settings → Variables and Secrets 中添加 Secret：`SDBOT_GITHUB_WEBHOOK_SECRET`、可选 `SDBOT_GITCODE_WEBHOOK_SECRET`、`SDBOT_GITHUB_APP_PRIVATE_KEY`。私钥保留完整多行 PEM，通过页面 Deploy 生效；不要放进普通 `vars`、工作流 inputs 或聊天。将非敏感的 `SDBOT_GITHUB_APP_ID` 写入 Wrangler `vars`。本机 `.env` 不会自动复制到 Worker；看板 Actions 不保存 App 私钥。至少一个平台必须有密钥；未配置密钥的平台直接拒绝，Worker 不支持免签接入。
5. 为 Worker 选择一个新的域名，在 Settings → Domains & Routes 添加 Custom Domain，并将对应 `routes` 同步回 Wrangler 配置；先保留当前 Tunnel 域名。检查新地址的 `/healthz` 只返回 `{"ok":true}`、`/api/status` 返回 404，再使用 `/webhook/github` 接收签名投递。Webhook 地址不能要求浏览器交互登录。
6. GitHub App 的 Webhook URL 属于 App 注册配置，修改会影响该 App 的全部安装；不能借此只切测试仓。先在实验源仓配置独立的临时仓库 Webhook，指向新地址，保持原 App 地址不动。先验证归档，再停用 Compose 对测试看板的自动触发并让 Worker 仅启用测试目标；核对签名失败、未知事件、重复投递、R2／SQLite 留存及真实采集／Pages 结果。
7. 启用采集时配置 `SDBOT_BOARD_TARGETS` 的 JSON 字符串映射，并恢复 `triggers.crons=["*/5 * * * *"]` 后部署。看板目标一旦启用并初始化，即使没有新投递，也可能经 Alarm 触发周期刷新；仅关闭 Cron 不能停用持久 Alarm。首次准备同时保持目标为空，正式切换前停用旧进程对应的看板触发，避免两套 Bot 重复调度。
8. 验证签名、持久存档、实际监听结果与 Actions 触发后，修改 App Webhook URL 切换。管理认证单独按[只读管理配置](cloud-admin.md)开通；未完成时必须保持管理入口拒绝访问，不能将“接收已上线”视为“面板已可登录”。旧档案不迁移，保留数据卷；两看板仓的 `.sync/` 和 `site/` 不变。普通仓库／组织 Webhook 的 URL 也需要逐项核对；验证完移除临时测试 Webhook。保留旧数据卷和回退配置，确认新链路稳定后停止旧接收入口。

部署命令成功不代表所有 Durable Object 已立即使用新代码和配置：云端传播可能持续数秒至数分钟，存储访问还可能因实例切换而失败。不要紧接部署就切正式 Webhook，也不能仅凭 `/healthz` 判断监听目标已经生效。用带明确测试标记的新 delivery 验证实际归档中的监听结果及目标 Actions 运行；关闭临时目标后也要验证实际结果已回到 `noop`。服务更新窗口收到 503 的投递需要重试；已经按旧配置接受的事件若需重新采集，应在看板仓运行 Actions，普通 redelivery 可能被去重。参见 [Cloudflare 生命周期说明](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)与[已知更新边界](https://developers.cloudflare.com/durable-objects/platform/known-issues/)。

`workers:local` 的管理页只查询独立的本地模拟存储，不能查询已部署 Worker 或 Compose 数据。云端 `/admin/` 和 `/admin/api/*` 已提供只读管理，必须配置 Access 应用及对应 issuer／AUD／域名后才能访问。旧 JSONL／正文不导入云端，保留本机数据卷供需要时在关闭调度的本机管理进程查询；这不影响看板从 GitHub API 继续采集。旧 Tunnel 地址已不再作为 App 接收入口。

## 验证入口

`npm run check` 分开检查 Node 与 Worker 类型；`npm run workers:check` 只执行 Wrangler dry-run，不创建资源、不发布；`npm run test:worker-adapter` 使用真实持久存储模拟器和模拟 GitHub 端点，包含重启前后的重复投递、原始请求／响应、拒绝管理重放、两站点调度和失败恢复。完整验证见[验证指南](../testing.md)。

参考：[SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[持久 Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)、[工作流触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[GitHub 工作流触发限制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
