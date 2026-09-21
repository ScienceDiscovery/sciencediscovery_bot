# sciencediscovery_bot（webhook 机器人框架）

接收 GitHub App、GitHub 普通组织／仓库 Webhook 和 GitCode 仓库 Webhook，验签后把 issue、PR、merge、评论、push 等事件归一化成统一事件模型，分流到内置 handler 并落盘；为后续「Issue/PR 自动分析检视」和「看板联动更新」预留 hook。组织无法安装 App 时，可直接配置普通 Webhook，无需 App ID、私钥、installation 或 PAT。纯 Python 3 标准库，无第三方依赖；可直接在宿主机跑，也可用 Docker Compose 和 Cloudflare Tunnel 一起跑。

本阶段只有框架：hook 全部 no-op，不发评论、不改看板、不调用 LLM。

## 两个监听

| 监听 | 默认地址 | 作用 | 可否对外 |
|---|---|---|---|
| webhook | `127.0.0.1:8791` | `POST /webhook`、`/webhook/github`、`/webhook/gitcode`、`GET /healthz`，其余路径返回 404 | 这是**唯一**可以通过隧道转发出去的端口 |
| admin | `127.0.0.1:8792` | 管理面板 `/`、`/api/status`、`/api/events`、`POST /api/replay/<id>` | **不得转发**；发现 Cloudflare 隧道头即 403，可再加 `SDBOT_ADMIN_TOKEN` |

webhook 监听对外只回最少信息：成功 `{"ok": true, "delivery_id": "…"}`（ping 多一个 `pong: true`），验签失败 `401 {"ok": false, "error": "signature verification failed"}`，坏请求 400，超大 413，其余路径 404；错误页是 JSON，`Server` 头不带 Python 版本。路由、hook、payload 文件、拒绝原因、仓库允许列表、部署信息都只在 admin 监听和事件日志里。

## 宿主机模式

```bash
cd sciencediscovery_bot
export SDBOT_WEBHOOK_SECRET='<与 App/Webhook 配置一致的密钥>'   # 不设则以「未验签模式」运行并在日志里警告
export SDBOT_ADMIN_TOKEN='<可选，管理面板口令>'
./run.sh start            # webhook http://127.0.0.1:8791/webhook  admin http://127.0.0.1:8792/
./run.sh status|logs|restart|stop
python3 server.py         # 前台运行（Ctrl-C 退出）；--no-admin 只起 webhook
./run.sh test             # 单元测试 + 本地 HTTP 端到端
./run.sh replay --all     # 把全部 fixture 签名后回放，并从 admin 监听读回路由 / hook
```

宿主机模式两个监听都只允许 loopback（非 loopback 直接拒绝启动，除非 `SDBOT_ALLOW_NON_LOOPBACK=1`）。要接真实平台，在宿主机另起 `TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" cloudflared tunnel run`，把隧道的 public hostname 指到 `http://127.0.0.1:8791`。

## Docker Compose + Cloudflare Tunnel

宿主机模式与 Compose 使用相同端口，切换前先 `./run.sh stop`。本目录为独立 Git 仓库，不依赖父仓。

```bash
cp .env.example .env            # 填 SDBOT_*_WEBHOOK_SECRET、CLOUDFLARE_TUNNEL_TOKEN；有真实 token 后取消 COMPOSE_PROFILES=tunnel 的注释
docker compose up -d --build    # bot + cloudflared（.env 里有 COMPOSE_PROFILES=tunnel 时）
docker compose logs -f cloudflared # 看隧道连接状态
docker compose ps
docker compose down             # 加 -v 同时删事件日志卷 bot-data
```

没有 token 或只想本地回放：保持 `.env` 里的 `COMPOSE_PROFILES=tunnel` 为注释（默认状态，或不建 `.env`），`docker compose up -d --build` 就只起 bot；临时要带隧道用 `docker compose --profile tunnel up -d`。

暴露模型：

- `cloudflared` 通过 compose 私有网络访问 `http://bot:8791`（webhook 监听）。在 Cloudflare Zero Trust → Networks → Tunnels 里给这个隧道配 Public hostname，Service 填 `HTTP` + `bot:8791`。**不要**配任何指向 `bot:8792` 的 hostname。
- 宿主机端口只发布到 `127.0.0.1`：`127.0.0.1:8791`（本地回放 / curl）和 `127.0.0.1:8792`（管理面板）。局域网和公网都碰不到；隧道是唯一的外部入口。
- 即使隧道被错误地指向 8792，admin 监听看到任意 `Cf-*` 头（大小写不敏感，包括空值）也会 403；再设 `SDBOT_ADMIN_TOKEN` 则还需要 `Authorization: Bearer`。
- 容器内以非 root 用户 `sdbot`（uid 10001）运行；事件日志在命名卷 `bot-data`（容器内 `/data`）。看日志：`docker compose exec bot tail -n 20 /data/events.jsonl` 或直接开管理面板。容器内也能回放：`docker compose exec bot python3 scripts/replay.py --all`。
- `.env` 只被 compose 读取；`bot` 容器只拿到 `SDBOT_*` 变量，`cloudflared` 只拿到 `TUNNEL_TOKEN`。`.env` 已在 `.gitignore`。

配置依据：[Cloudflare 隧道参数](https://developers.cloudflare.com/tunnel/reference/run-parameters/)（`TUNNEL_TOKEN`）、[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)（等待 bot 健康）、[端口发布](https://docs.docker.com/reference/compose-file/services/#ports)（绑定 loopback）。不要把含真实密钥的 `docker compose config` 完整输出贴进日志或报告，日常校验用 `docker compose config -q`。

拿 token：Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → 选 Docker，页面给出的命令里 `--token` 后面那串就是 `CLOUDFLARE_TUNNEL_TOKEN`。再在同一页 Public Hostname 里加子域名 → `HTTP` → `bot:8791`。GitHub App / GitCode 的 Webhook URL 就是 `https://<子域名>/webhook/github` 或 `/webhook/gitcode`。

## 配置（环境变量，都可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SDBOT_GITHUB_WEBHOOK_SECRET` | 无 | GitHub App、普通组织／仓库 Webhook 的 Secret；同一实例的 GitHub 来源共用此值 |
| `SDBOT_GITCODE_WEBHOOK_SECRET` | 无 | GitCode 仓库 Webhook 的密钥（签名模式或密码模式共用同一值） |
| `SDBOT_WEBHOOK_SECRET` | 无 | 上面两个都没设时的共用回退 |
| `SDBOT_WEBHOOK_HOST` / `SDBOT_WEBHOOK_PORT` | `127.0.0.1` / `8791` | webhook 监听（旧名 `SDBOT_HOST` / `SDBOT_PORT` 仍可用） |
| `SDBOT_ADMIN_HOST` / `SDBOT_ADMIN_PORT` | `127.0.0.1` / `8792` | admin 监听；`SDBOT_ADMIN_ENABLED=0` 关闭 |
| `SDBOT_ADMIN_TOKEN` | 无 | 设了以后 admin 监听要求 `Authorization: Bearer <token>`（面板地址使用 `http://127.0.0.1:8792/#token=<URL 编码的口令>`） |
| `SDBOT_ALLOW_NON_LOOPBACK` | `0` | 允许绑定 `0.0.0.0`，只在容器里用（镜像已设） |
| `SDBOT_RUN_DIR` | `./.run` | 宿主机 PID / 日志目录；可为验证指定独立目录 |
| `SDBOT_DATA_DIR` | `./.data`（容器 `/data`） | 事件日志与原始 payload 目录 |
| `SDBOT_REPOS` | 空 = 全收 | 逗号分隔的 `owner/name` 允许列表，其余仓的事件记为 `ignored`（对发送方仍回 200） |
| `SDBOT_MAX_BODY_MB` | `25` | 请求体上限（GitHub 单次投递上限 25 MB），超过返回 413，保留上限内收到的前缀并标记不完整 |
| `SDBOT_DEDUPE_WINDOW` | `2000` | 记住的 delivery id 数，用于识别平台重投 |
| `SDBOT_LOG_LEVEL` | `INFO` | 日志级别 |

服务端密钥和管理口令只从环境变量读取，不写入事件文件、日志或 `/api/status`（那里只显示 `secret_configured` / `token_required`）。

## 管理面板与 admin API

- `GET /`：无部署数据的静态面板外壳，无需口令即可加载；配置口令后所有数据 API、管理健康检查和重放仍需 Bearer 认证。地址片段 `#token=…` 不随 HTTP 请求发送，脚本读取后会从地址栏移除，仅保存在当前页面内存中；重新加载页面需重新提供口令，禁止使用 `?token=…`。访问日志不记录 URL 或请求头。
- 面板内容：密钥配置状态、计数、最近事件表（按 kind / status / route / number 过滤，10 s 自动刷新），每条可「查看详情」，有完整正文时可「重放」；上一页/下一页浏览全部历史，浏览旧页时暂停自动刷新。
- 列表和详情的事件接收时间按浏览器时区显示，页头标明当前时区，自动处理夏令时；悬停时间可查看原始时间戳。存档、API 和请求／返回原文中的时间保持原值。
- `GET /api/status`：配置视图（无密钥）、计数、最近一条记录。
- `GET /api/events`：返回事件摘要、`offset` 和 `has_more`；参数 `limit`（默认 50，最多 500）、`offset`（默认 0）、`kind`、`route`、`repo`、`number`、`status`、`provider`、`action`、`delivery_id`。
- `GET /api/events/<record_id>`：单次投递的请求方法/路径、脱敏请求头、原始正文、返回状态/头/正文；详情仅在 8792 可读。支持 JSON 格式化和原文切换，非 UTF-8 请求以 Base64 展示。
- `POST /api/replay/<record_id>`：把已存的原始 payload 以新的 delivery id、用当前配置的密钥重新签名后再送入管道（以后 hook 实现好了拿真实投递重跑很方便）。按独立 record_id 选择具体的一次投递，兼容旧客户端的 delivery_id；不完整正文不能重放，form-encoded 投递会保留原 Content-Type。需要请求头 `X-Requested-With: sciencediscovery-bot`，浏览器发起时 Origin 必须与 Host 一致。

## 验签

- GitHub：`X-Hub-Signature-256: sha256=<hex HMAC-SHA256(body, secret)>`，常量时间比较；忽略旧的 `X-Hub-Signature`（SHA-1）。
- GitCode：签名模式 `X-GitCode-Signature-256: sha256=<HMAC-SHA256>`（官方文档没写摘要是 hex 还是 base64，两种都接受）；密码模式 `X-GitCode-Token: <密码>`，与同一密钥常量时间比较。两者同时出现时以签名头为准。
- 对应平台没有配置密钥时，该平台的投递按「未验签」接受并在启动日志里 WARNING；对外暴露前务必配好密钥。

## 事件模型与分流

适配器把两个平台的 payload 归一化为 `Event`：`provider`、`delivery_id`、`kind`、`action`、`repo`、`number`、`title`、`url`、`sender`、`merged`、`labels`、`ref`、`raw_event`、`raw_action`、`extra`（分支、状态、评论 id 等小字段）、`payload`（原始对象，不进日志）。词汇沿用 GitHub：`kind` 是事件族，`action` 是 GitHub 的动作名，GitCode 的 `open/close/reopen/update/merge` 映射为 `opened/closed/reopened/edited/merged`，MR `update` 且带 `oldrev` 视为 `synchronize`（推了新提交）。

| 平台原始事件 | 统一路由 `kind.action` | Router handler | 调用的 hook |
|---|---|---|---|
| GitHub `ping` | `ping.ping` | `on_ping` | 无（回 `pong: true`） |
| GitHub `issues` opened/edited/reopened；GitCode `Issue Hook` open/update/reopen | `issue.opened` 等 | `on_issue` | `analyze.on_issue` + `board.on_issue` |
| GitHub `issues` closed/labeled/assigned/…；GitCode `Issue Hook` close | `issue.closed` 等 | `on_issue` | `board.on_issue` |
| GitHub `issue_comment`；GitCode `Note Hook`（Issue / MergeRequest / Commit） | `issue_comment.created` | `on_issue_comment` | `analyze.on_issue_comment` + `board.on_issue_comment` |
| GitHub `pull_request` opened/synchronize/reopened/edited/ready_for_review；GitCode `Merge Request Hook` open/update/reopen | `pull_request.opened` 等 | `on_pull_request` | `analyze.on_pull_request` + `board.on_pull_request` |
| GitHub `pull_request` closed 且 `merged=true`；GitCode `Merge Request Hook` action=merge 或 state=merged | `pull_request.merged` | `on_pull_request_merged`（单独分流） | `analyze.on_pull_request_merged` + `board.on_pull_request_merged` |
| GitHub `pull_request` closed 且未合并；GitCode close | `pull_request.closed` | `on_pull_request` | `board.on_pull_request` |
| GitHub `pull_request_review` / `pull_request_review_comment` | `pull_request_review.submitted` 等 | `on_pull_request_review` | `analyze.on_pull_request_review` + `board.on_pull_request` |
| GitHub `push`；GitCode `Push Hook` / `Tag Push Hook` | `push.pushed` | `on_push` | `board.on_push` |
| GitHub `installation` / `installation_repositories` | `installation.created` 等 | `on_installation` | 无，只记录 |
| 其他任何事件（如 `star`） | `unknown.<raw_event>` | 无 | 无，只记录，返回 200 |

同一 `delivery_id` 再次到达（GitHub「Redeliver」或超时重投）会被标记 `duplicate: true` 并跳过 hook，重启后仍能识别（启动时恢复历史计数及近期 delivery ID）。

### Hook（`sdbot/hooks.py`，本阶段 no-op）

- `AnalyzeHandler`：未来的 Issue/PR 自动分析检视入口。`on_issue`、`on_issue_comment`（预留 `/analyze` 这类斜杠命令）、`on_pull_request`、`on_pull_request_review`、`on_pull_request_merged`。
- `BoardUpdater`：未来由 App 或普通 Webhook 事件触发下游看板更新，可按需接入刷新队列与去抖动逻辑。当前只记录调用。
- 每次调用都返回 `{"hook","method","status":"noop"}`，写进事件日志的 `hooks` 列，所以「hook 被路由器真正调用」在日志里可查。实现时把 no-op 换成真逻辑即可，不需要改管道；hook 抛异常会被路由器捕获并记入 `errors`，不影响响应。

## 落盘（`.data/`，容器内 `/data`）

每次 webhook POST 都独立留存：成功、未知事件、错签/无签、被允许列表忽略、重复投递、错误 URL（404）、坏 JSON（400）和处理异常（500）均有记录。重复 delivery_id 会得到不同的 `record_id`，只对处理 hook 去重，不再丢弃重复请求原文。健康检查及普通 GET 浏览请求不作为 webhook 投递入账。

- `events.jsonl`：每次投递一行摘要，包含原有事件/路由/hook 字段及 `record_id`、`http_status`、`request_method`、`request_path`、`payload_file`、`detail_file`、`body_complete`。
- `payloads/YYYY-MM-DD/<record_id>.body`：原始请求字节；默认接收上限 25 MB，取消旧的 512 KB 保存上限，正文不再按成功/重复/忽略状态筛掉。
- `deliveries/YYYY-MM-DD/<record_id>.json`：请求方法、路径、脱敏请求头、正文完整性、声明长度、处理耗时，以及本服务生成的响应状态、头和正文。Cloudflare 在外层添加的响应头不属于该记录，也不据此断言客户端一定收到响应。

请求正文在接收上限内完整保存。超限请求保留已收到的前缀并返回 413；中断或超时保留已收到内容并标记不完整；非法 Content-Length 或不支持的 Transfer-Encoding 只保存可取得的元信息和返回。磁盘写失败返回 503，不把未成功存档的投递报告为成功。新文件写完并 fsync 后才追加索引，返回给平台前完成持久化；没有自动删除历史的策略，卷会随投递增长。

Authorization、Cookie、Token、签名、API key 等凭据头在写入前替换为 `[REDACTED]`，URL 查询参数值也脱敏；原始业务正文按收到的字节保存。详情只由管理口的原有鉴权和 Cloudflare 拒绝规则保护。原来的 `SDBOT_STORE_PAYLOADS` / `SDBOT_PAYLOAD_MAX_KB` 不再控制新投递留存。

旧 `events.jsonl` / payload 文件保持兼容，旧记录有原文时仍能查看/重放。以前未保存的请求头、返回、正文不会补造，管理页明确显示“历史记录未保存”。新列表查询和详情查找覆盖整个历史，不再局限最后 200 行或 4 MB；翻页时每页最多 500 条。历史量很大时过滤查询仍需扫描 JSONL。

## 本地回放（没有远端 App 也能打通）

`fixtures/` 里是最小真实形态的投递样本，信封格式 `{"provider","event","delivery","description","payload"}`，GitHub 14 个（ping、installation、issues opened/labeled/assigned/closed、issue_comment、PR opened/synchronize/review/closed 未合并/closed 已合并、push、未知事件 star），GitCode 9 个（Issue open/close、MR open/update/merge/close、Note on Issue/MR、Push）。GitCode 样本按官方文档示例的字段形态构造，真实 App 接入后应用 `.data/payloads/` 里的真实投递替换或补充。

```bash
export SDBOT_WEBHOOK_SECRET='...'                         # 与服务同一个密钥；设了 SDBOT_ADMIN_TOKEN 也一并导出
./run.sh replay --all                                     # 全部 fixture，逐条打印 HTTP 状态 / 路由 / hook（路由和 hook 来自 admin 监听）
./run.sh replay fixtures/github/pull_request_closed_merged.json
./run.sh replay --all fixtures/gitcode                    # 只回放 GitCode
./run.sh replay --bad-signature fixtures/github/ping.json # 期望 401
./run.sh replay --no-signature  fixtures/github/ping.json # 期望 401（设了密钥时）
./run.sh replay --token-mode fixtures/gitcode/issue_open.json   # GitCode 密码模式
./run.sh replay --keep-delivery-id f.json f.json          # 第二次被标记 DUPLICATE
./run.sh replay --print-curl fixtures/github/ping.json    # 打印已签名 curl；GitCode 密码模式仅引用环境变量，不打印密钥
./run.sh replay --url http://127.0.0.1:8791/webhook --admin-url http://127.0.0.1:8792 …   # 指向容器发布的端口
curl -sS 'http://127.0.0.1:8792/api/events?route=pull_request.merged'
```

每次回放默认生成新的 delivery id（避免被当成重投），密钥从 `SDBOT_<PROVIDER>_WEBHOOK_SECRET` / `SDBOT_WEBHOOK_SECRET` 读取，不接受命令行传密钥。

## 测试

测试临时目录应位于项目内：先执行 `mkdir -p .tmp/test-tmp`，再执行 `TMPDIR="$PWD/.tmp/test-tmp" ./run.sh test`。下述 HTTP 组在进程内启动真实监听；宿主机/Compose 的启动、健康检查和清理还应单独验证。

```bash
./run.sh test            # 等价于 python3 -m unittest discover -s tests -t .
```

覆盖：验签（GitHub / GitCode hex+base64 / 密码模式 / 缺失 / 错误 / 未配密钥）、23 个 fixture 的归一化表、路由器对每条路由调用的 hook 列表、merge 的独立分流（两个平台）、未知事件只记录、hook 异常隔离、重投识别与重启后识别、仓库允许列表、form-encoded 投递、大 payload 完整保存、超限/中断请求标注不完整、拒绝/忽略/重投独立留存、响应快照、历史翻页、旧记录兼容、重启计数恢复、配置校验（非 loopback / 端口冲突），以及普通 GitHub Webhook 的组织／仓库／无目标头 × JSON／表单 × ping／Issue／PR／merge／未知事件共 30 组场景（无 installation，验证原文和返回可查询、hook 被调用），表单原始字节验签、拒绝后正确重投和重复投递归档；真实 HTTP 端到端：两个监听在临时端口拉起，用 `scripts/replay.py` 驱动，验证公网面只有 `/healthz` 与 webhook、响应最小、`Server` 头无版本、401/413/404、任意大小写/空值的 `Cf-*` 头在 admin 上均返回 403、口令 401、`/api/events`、`/api/replay`、`/api/status` 不泄露密钥。

浏览器回归使用固定版本 `test/e2e.package.json`，依赖和浏览器均装在被忽略的 `.e2e/`：

```bash
node test/sync-e2e.mjs
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs
```

测试启动真实服务于隔离端口 18891/18892，覆盖投递→详情→原文/格式化→精确重放、401/404 请求内容与返回、历史分页、旧数据和空列表，并保存桌面/窄屏截图。测试与实际部署使用不同端口。运行产物位于 `.e2e/`，确认需要保留的证据后可删除该目录。

## 在组织上创建 App / Webhook（人类操作清单）

服务需要公网 URL 才能收到平台投递。用 Compose 时就是上面的 Cloudflare Tunnel；宿主机模式则在本机另起 `TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" cloudflared tunnel run` 并把 public hostname 指到 `http://127.0.0.1:8791`。下面的 `<public-host>` 就是隧道的域名。

### GitHub 普通组织／仓库 Webhook（无需安装 App）

1. 有组织 owner 权限时：组织 → Settings → Webhooks → Add webhook；仅有仓库管理权限时：目标仓库 → Settings → Webhooks → Add webhook。仓库 Webhook 只覆盖该仓库，多仓需要分别配置。创建权限由 GitHub 控制，普通 Webhook 不能绕过组织／仓库的管理权限。
2. Payload URL：`https://<public-host>/webhook/github`，不要加末尾 `/`，也不要填写管理端口或 `/api/status`。
3. Content type 选 `application/json`；已有的 `application/x-www-form-urlencoded` 也支持，服务对原始请求字节验签后才解析表单的 `payload` 字段。
4. Secret 填服务已经配置的 `SDBOT_GITHUB_WEBHOOK_SECRET`（未设置该专用变量时用 `SDBOT_WEBHOOK_SECRET`）。App 和普通 Webhook 使用同一个接收地址和 GitHub 密钥配置；新增 Webhook 时不必改已有 App 的密钥。若修改本地 `.env`，用 `docker compose up -d bot` 更新容器环境，宿主模式需重新加载环境后重启。
5. 选 Let me select individual events，勾选 Issues、Issue comments、Pull requests、Pull request reviews、Pull request review comments；需要接收提交时再勾 Pushes。开启 Active，保留 SSL verification，保存。
6. GitHub 保存后自动发送 `ping`：Recent Deliveries 应显示 HTTP 200，响应包含 `pong: true`；在本机 8792 管理面板可看到 `ping.ping` 及请求／响应详情。随后创建或更新一个 Issue／PR，确认相应路由和 hook 已记录。

普通 Webhook 与 App 投递使用相同的验签、分流、merge 识别、归档、详情和重放链路；`installation` 和 App 专属头都不是必填项。仓库允许列表 `SDBOT_REPOS` 同样生效。GitHub 来源目前每个实例只配置一个密钥；需要隔离密钥的组织可分别部署实例。

这提供事件触发能力，未来向 GitHub 发评论、改标签等写回操作仍需要另配有权限的凭据。App 与普通 Webhook 同时订阅同一仓库、同一事件时可能各投递一次；当前只按 delivery ID 去重，建议避免重叠订阅。

官方说明：[创建组织／仓库 Webhook](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)、[验证 Webhook 签名](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。

### GitHub App（组织 ScienceDiscovery，安装到镜像仓 `openJiuwen-ai/sciencediscovery`）

1. 组织 → Settings → Developer settings → GitHub Apps → New GitHub App。
2. GitHub App name：`sciencediscovery-bot`（全站唯一，被占用就加后缀）；Homepage URL 随意填仓库地址。
3. Webhook：勾 Active；Webhook URL `https://<public-host>/webhook/github`；Webhook secret 填一个随机串，同一个值写进 `.env` 的 `SDBOT_GITHUB_WEBHOOK_SECRET`（不要写进任何仓库或文档）。
4. Repository permissions（最小集）：Metadata Read-only（必选）、Issues Read-only、Pull requests Read-only、Contents Read-only（只为 push 事件；不要 push 可不勾）。以后要发评论/打标签时再把 Issues、Pull requests 升到 Read and write。Organization / Account permissions 都不需要。
5. Subscribe to events：Issues、Issue comment、Pull request、Pull request review、Pull request review comment、Push（可选）。`ping`、`installation`、`installation_repositories` 不用勾，自动会发。
6. Where can this GitHub App be installed：Only on this account。Create GitHub App。创建成功后 GitHub 立刻向 Webhook URL 发一条 `ping`，在 App 设置页 Advanced → Recent Deliveries 能看到响应和 Redeliver 按钮；本地管理面板应出现一条 `ping.ping`。
7. 左侧 Install App → 选组织 → Only select repositories → `openJiuwen-ai/sciencediscovery` → Install。此时收到 `installation.created`。
8. 本阶段不需要下载 private key、不需要 App ID / Client secret（那是阶段二以 App 身份写回时才要）。

### GitCode 仓库 Webhook（`openJiuwen/sciencediscovery`）

GitCode 没有 GitHub App 这种安装体，只有仓库级 WebHook（文档：docs.gitcode.com → 帮助 → 组织与项目 → WebHook）。

1. 仓库 → 设置（管理） → WebHook → 新建。
2. URL：`https://<public-host>/webhook/gitcode`。
3. 认证二选一：签名密钥（推荐，请求头 `X-GitCode-Signature-256`）或 WebHook 密码（请求头 `X-GitCode-Token`）；填的值写进 `.env` 的 `SDBOT_GITCODE_WEBHOOK_SECRET`。
4. 事件勾选：Issue Event、Pull Request Event（请求头值 `Merge Request Hook`）、Note Event（评论）；Commit Event（`Push Hook`）和 Tag Push Event 可选。
5. GitCode 没有 `ping`：保存后用页面的测试按钮或随便改一个 Issue 触发一条，然后看管理面板。
6. 首条真实投递后看事件的 `verification` 字段：`hmac-sha256` 说明签名模式通了；若是 `rejected` 且原因是 mismatch，先怀疑摘要编码或密钥不一致。

## 相对真实 App 目前还缺什么

- Cloudflare 账号里创建隧道、拿 token、配 public hostname（本工具不代做）。
- 人类在 GitHub 创建普通组织／仓库 Webhook 或创建并安装 App，在 GitCode 建仓库 Webhook。
- GitCode 的 payload 只按官方文档样例构造，真实字段（尤其 Note、标签、reopen）要拿首批真实投递校准适配器。
- 阶段二功能：`AnalyzeHandler` 的分析逻辑、`BoardUpdater` 对看板的实际调用，以及以 App 身份写回（需要 App 私钥 + installation token）。

## 目录结构

```
server.py              两个监听：WebhookHandler（公网面）与 AdminHandler（面板 / API / 重放）
sdbot/config.py        SDBOT_* 环境变量与启动校验；密钥只在内存
sdbot/signature.py     GitHub / GitCode 验签与签名
sdbot/events.py        统一事件模型 Event 与 kind/action 常量
sdbot/adapters/        github.py、gitcode.py：平台 payload → Event；__init__.py 识别平台
sdbot/router.py        按 kind 分发到 handler，merge 单独分流，hook 异常隔离
sdbot/hooks.py         AnalyzeHandler / BoardUpdater（no-op，记录调用）
sdbot/store.py         events.jsonl + payloads/ + deliveries/，全量留存、详情查询、历史分页
sdbot/pipeline.py      一次投递的完整处理：验签 → 解析 → 归一化 → 过滤 → 路由 → 落盘；公网响应最小化
static/index.html      管理面板（原生 JS）
scripts/replay.py      fixture 签名回放 / 打印 curl / 从 admin 读回结果
fixtures/              GitHub 与 GitCode 投递样本（信封格式）
tests/                 unittest（验签、适配器、路由、管道、HTTP 端到端、配置校验）
Dockerfile, docker-compose.yml, .env.example   容器化与 Cloudflare Tunnel
run.sh                 宿主机模式 start/stop/restart/status/logs/test/replay
```

`.data/`、`.run/`、`.tmp/`、`.env` 在 `.gitignore`。本目录是独立 git 仓库；上层 `science_agent_utils` 通过 `.git/info/exclude` 忽略它。
