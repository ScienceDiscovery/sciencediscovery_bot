# Workers 运行适配与 Actions 采集

## 功能与边界

Worker 保留 Webhook 验签、事件总线、两个源仓范围、全量投递存档与最小公开响应；看板采集由目标看板仓的 GitHub Actions 执行，Python 采集器继续使用。无需在 Worker 内启动 Python，也不依赖 cloudflared。

本地适配使用真实 workerd、SQLite Durable Object 和 R2 模拟存储，可验证重启恢复、查询、重放、去重与调度。仓库提供生产 Worker 入口和 Wrangler 配置，但不会自动创建账号资源或切换现有服务。现有 Compose 与数据卷独立保留；本地模拟器既不读取 Compose 的 `.env`，也不读取其历史数据。

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

- `src/worker/index.ts`：公开 Fetch、Cron 与 `BotObject`。所有投递都进入固定名称 `archive-v1`，避免多个 Worker 实例各自去重。管理方法只通过 Durable Object RPC 可达，公开路由不会转入管理方法。
- `src/worker/archive.ts`：完整正文和包含请求／应用响应的详情先写 R2，随后用 SQLite 事务写查询索引、计数、delivery 去重和待刷新状态。存储失败返回 503，不确认成功；失败前写入的 R2 对象可能成为未索引对象，后续维护不能只按日期随意清理。
- `src/worker/board.ts`：订阅处理器暂存本次刷新意图，只有归档事务成功才计入 `requested`。同仓短时间事件合并，默认 20 秒去抖、成功触发间隔至少 60 秒；失败从 30 秒指数退避到 600 秒。发送前保存 120 秒执行租约，崩溃后恢复。Alarm 执行期间不阻塞新投递；每五分钟 Cron 修复调度，空闲站点默认每小时刷新一次。
- `src/core/actions.ts`：只为目标看板仓申请 `Metadata: read / Actions: write` 安装令牌，调用固定 `collect.yml`、固定 `main`，传入源仓和刷新编号。私钥、令牌、原始 Webhook 内容不会作为工作流 inputs 传递。
- `tools/workers-local.mjs` 与 `src/worker/local-admin.ts`：本地管理桥和现有面板。校验 loopback hostname，并继续拒绝 Cf-* 头；公网 bundle 不包含管理页面或本地桥。

去重沿用最近 2000 个已接受 delivery 的窗口，可由 `SDBOT_DEDUPE_WINDOW` 调整；被去重的重复请求仍独立归档。SQL 筛选索引字段最多 4096 字符，完整字段保存在 R2 详情中。API 查询／分页／重放协议与 Node 管理端一致，旧文件归档不会自动导入这个新存储。

Actions 调用在网络断开或进程崩溃时可能重试；GitHub dispatch 接口没有本项目可依赖的去重键，因此不承诺远端任务恰好执行一次。采集是重新计算快照，目标仓 `concurrency` 串行执行，提交仍是非强制更新。工作流失败不会把旧页面删掉。

管理状态中 `execution=github_actions`、`dispatched`、`last_dispatch` 只表示 GitHub 已接受任务；`last_success` 与 `commit` 不虚构发布结果。面板显示“已触发采集”。采集结果和 Pages 发布结果分别查看目标仓的两个 Actions 工作流。调度只重试触发失败，已被 GitHub 接受后发生的采集失败由下一轮刷新／人工重跑恢复。

## Actions 配置

两个看板仓都需要 `collect.yml`、`collection_context.py` 和已有采集器代码。相同工作流按照运行仓从 `board-config.json` 选择唯一源仓，拒绝传入另一个源仓或未知目标；正式与测试快照不能互相覆盖。

在各目标仓设置仓库变量 `SDBOT_GITHUB_APP_ID`、仓库 Secret `SDBOT_GITHUB_APP_PRIVATE_KEY`。私钥可以使用多行 PEM。不要放入 workflow 文件、inputs、输出或 artifact。工作流通过 `actions/create-github-app-token@v2` 分别申请源仓只读和目标仓 Contents 写令牌，并在任务结束时撤销。

源仓读取权限沿用看板要求：Contents、Issues、Pull requests、Actions、Checks、Commit statuses；目标仓需要 Contents 写与触发任务的 Actions 写权限。App 必须安装到两端，跨组织分别使用对应 installation。Actions 用 App 令牌提交 site，使已有 `pages.yml` 的 push 触发器生效；不能换成默认 GITHUB_TOKEN 写入后期待自动触发另一个工作流。

在 App 注册页 **Permissions & events → Repository permissions → Actions** 选择 **Read and write** 后，还需目标组织批准 installation 的新增权限。应检查目标仓 installation 返回的 `permissions.actions` 已是 `write`，不能只看注册页。此权限与仓库 Actions 设置中的默认 `GITHUB_TOKEN` 权限不同；后者可以保持只读，Pages 工作流按 job 声明所需权限。

验收分为三步：App 安装令牌成功触发 `collect.yml`；采集任务使用两个安装令牌读取源仓、提交目标仓 `site/`；该 App 提交触发 `pages.yml` 并部署成功。管理员手动触发成功只能验证后两步。仅配置看板仓不会切换当前 Node / Compose 的采集模式，正式切换仍需部署 Worker 并迁移 Webhook 接收链路。

## 上线前的步骤（本地验收不会执行）

1. 将采集工作流和校验脚本同步到正式、测试看板仓，保留各自的 `site/data/snapshot.json`；配置 App 权限、仓库变量与 Secrets，并分别验收真实采集工作流。
2. 创建私有 R2 bucket，保持无公开域名／公开读取；按 `wrangler.jsonc` 设置名称。首次部署建立 SQLite Durable Object 命名空间，后续不要随意改类名、迁移标签或 `archive-v1`，以免指向另一份历史。
3. 在 Worker 配置 `SDBOT_BOARD_TARGETS` 与 App ID；通过 Workers Secrets 保存 `SDBOT_GITHUB_WEBHOOK_SECRET`、可选 GitCode secret、`SDBOT_GITHUB_APP_PRIVATE_KEY`。至少一个平台必须有密钥；未配置密钥的平台直接拒绝，Worker 不支持免签接入。
4. 执行 `npm run workers:check` 本地打包检查；确认账号后再用 Wrangler 登录、部署和绑定域名。默认 `workers_dev=false`、`preview_urls=false` 且无 routes，避免误部署立即开放地址。
5. 云端管理通道和旧档案迁移需要单独完成再切换正式使用；本地管理页当前只查询本地模拟数据，无法查询已部署 Worker 的历史。本轮不提供未经认证的公网管理页面，也不自动迁移既有 JSONL／正文。
6. 先切测试 Webhook，核对签名失败、未知事件、R2／SQLite 留存及采集／Pages 结果，再切正式 Webhook；完成后才停止旧接收链路。

## 验证入口

`npm run check` 分开检查 Node 与 Worker 类型；`npm run workers:check` 只执行 Wrangler dry-run，不创建资源、不发布；`npm run test:worker-adapter` 使用真实持久存储模拟器和模拟 GitHub 端点，包含重启前后的重复投递、原始请求／响应、重放、两站点调度和失败恢复。完整验证见[验证指南](../testing.md)。

参考：[SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[持久 Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)、[工作流触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[GitHub 工作流触发限制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
