# 外部调用（证书兑换令牌）

## 功能与边界

外部服务可以用自己的证书向 Bot 兑换一个 GitHub 安装令牌，然后自己调用 `api.github.com`；令牌权限由管理页的客户端选择与相关安装当前已获批的权限取交集，默认用于处理 Issue 和 PR。这与看板 Actions 用 OIDC 兑换令牌的方式一样：Bot 只负责签发，不代为执行任何写操作，只支持 GitHub。

调用方自己保管私钥，Bot 只保存它的公钥证书（PEM）。接口 `POST /caller/v1/token` 由正式 Worker 的入口单独处理：
- **故意不在 Cloudflare Access 后面**：调用方是服务，靠证书和 JWT 证明身份；不要给这个路径加 Access，也不要打开 Worker 级 Access；
- **不是 Webhook**：请求不进入投递归档；
- 原来的 `/caller/v1/comments`、`/caller/v1/labels`、`/caller/v1/state` 已删除，返回 404；
- Node 本机运行不提供这项功能。

## 照着做

先在调用方自己的机器上用 openssl 生成一对 RSA 密钥和一张自签名证书（命令见下；也可以改用 P-256 EC 密钥）：`caller.key` 是私钥，只留在调用方，任何时候都不要上传；`caller.crt` 是证书，把它的全文粘贴到管理页「外部调用」里新增的客户端并保存（含私钥的 PEM 会被拒绝；RSA 证书对应 RS256，P-256 证书对应 ES256），保存后复制页面上显示的客户端 ID。之后每次需要令牌时，用私钥签一个新的 JWT：`iss` 和 `sub` 都填客户端 ID，`aud` 填 `sdbot:caller`，并带上 `iat`、`exp` 和一个随机的 `jti`，`exp - iat` 不超过 600 秒，每个 `jti` 只能用一次；把这个 JWT 放进 `Authorization: Bearer` 头，加上 `Content-Type: application/json`，向 `https://<管理页主机>/caller/v1/token` 发送 `POST`（主机名就是管理页地址栏里的主机，管理页「外部调用」上的命令会自动填成你正在打开的这台 Worker），正文只有 `{"repo":"openJiuwen-ai/sciencediscovery"}`，这个地址不经过 Cloudflare Access。成功时返回 `{ "token", "expires_at", "repository", "permissions" }`：把 `token` 放进 `Authorization: Bearer`，直接请求 `https://api.github.com`，例如 `POST /repos/openJiuwen-ai/sciencediscovery/issues/123/comments`、正文 `{"body":"..."}` 就会以 GitHub App 的身份在 #123 下发一条评论；同一个令牌也可以处理 PR，因为 GitHub 的 PR 评论、标签和开关状态都走 Issues 接口。令牌带的实际权限由响应 `permissions` 列出，是客户端选择与当前安装上限的交集；默认只有 `metadata: read`、`issues: write`、`pull_requests: write`，不能改仓库文件；`expires_at` 是 GitHub 给的到期时间，大约一小时，过期后重新签一个 JWT 再兑换。仓库必须在 `SDBOT_REPOS` 中，客户端填了仓库允许列表时还必须在列表里；保存和兑换都会把权限收窄到相关安装已批准的范围；除元数据外没有可签发权限时返回 503，不签发只有元数据的令牌；每个客户端每分钟最多兑换 60 次。

```bash
# 1. 生成密钥对和证书（只做一次）。caller.key 是私钥，留在本机；caller.crt 粘贴到管理页「外部调用」。
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -keyout caller.key -out caller.crt -days 365 -subj "/CN=my-caller"
# 也可以用 P-256 EC 密钥（JWT 改用 ES256，需要用 JWT 库签名；下面第 2 步的 openssl 脚本只适用于 RSA）：
# openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -keyout caller.key -out caller.crt -days 365 -subj "/CN=my-caller"

# 2. 每次兑换前：用私钥签一个新的 RS256 JWT（有效 300 秒，jti 随机）。
CLIENT_ID='<管理页上显示的客户端 ID>'
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
NOW=$(date +%s)
HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iss":"%s","sub":"%s","aud":"sdbot:caller","iat":%s,"exp":%s,"jti":"%s"}' \
  "$CLIENT_ID" "$CLIENT_ID" "$NOW" "$((NOW + 300))" "$(openssl rand -hex 16)" | b64url)
SIGNATURE=$(printf '%s.%s' "$HEADER" "$PAYLOAD" | openssl dgst -sha256 -sign caller.key | b64url)
JWT="$HEADER.$PAYLOAD.$SIGNATURE"

# 3. 兑换令牌（这个地址不经过 Cloudflare Access）。
GRANT=$(curl -sS -X POST "https://<管理页主机>/caller/v1/token" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"repo":"openJiuwen-ai/sciencediscovery"}')
TOKEN=$(printf '%s' "$GRANT" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
printf '%s' "$GRANT" | python3 -c 'import json, sys; d = json.load(sys.stdin); print(d["repository"], "expires", d["expires_at"])'

# 4. 用令牌直接调用 GitHub：在 #123 下发一条评论（PR 同样走 Issues 接口）。
curl -sS -X POST https://api.github.com/repos/openJiuwen-ai/sciencediscovery/issues/123/comments \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"body":"..."}'
```

第 3 步失败时看返回的状态码：401 多半是 JWT 的客户端 ID、`aud`、有效期或 `jti` 不对；403 是仓库不在允许范围；503 表示收窄后仍无法签发（例如安装未批准任何所选权限、安装暂停、上游读取或签发失败），或 App 凭据不可用。令牌和私钥都不要写进日志或提交到仓库。

## 安装目录

管理页新增「安装」，只在打开该页或点击「刷新安装」时读取。`GET /admin/api/installations` 先验证 Cloudflare Access；其他方法 405，未认证 401，GitHub 读取失败 503 并明确显示读取失败，不把错误当作空成功列表。外部调用页也按需读取同一目录，用于选择仓库和计算权限上限；没有定时请求。

使用现有 App JWT 分页读取 `/app/installations`；未暂停安装用仅 `metadata:read` 的临时安装令牌分页读取 `/installation/repositories`。每个安装最多列出 1000 个仓库，超过时显示总数和截断提示。暂停安装仍列出账号和权限，但不读取仓库，也不能选择。只返回账号登录名、目标类型、all／selected、暂停状态、权限和仓库全名，不返回令牌、JWT 或私钥。权限目录内显示现有中文名，目录外的权限保留 GitHub 键名和级别。

安装目录查询与 Webhook 入库互斥锁无关，不在接收、Alarm、health 或兑换路径遍历完整目录；兑换只查询当前客户端范围内仓库的安装，复用安装响应里的权限，再为所请求的单个仓库申请令牌。Node 本地管理不提供此目录。

## 管理客户端

在 Access 保护的管理页「外部调用」中增删改查客户端，最多 20 个。每个客户端记录：
- **名称**；
- **证书**：只接受一个 `CERTIFICATE` 块，PEM 中出现任何私钥都会被拒绝保存。RSA 证书对应 RS256，P-256 EC 证书对应 ES256；
- **允许的仓库**：复选框只列出未暂停安装中且属于 `SDBOT_REPOS` 的仓库；不提供手填框。一项都不选仍表示允许 `SDBOT_REPOS` 中的全部仓库；写入不可选仓库返回 422。旧配置已不在列表中的名字显示为不可用，下次通过表单保存时去掉并提示。安装列表读取失败时不能修改仓库与权限，不回退手填，已有客户端保持原样；
- **令牌权限**：见下一节。

页面显示每个客户端的 ID（即 JWT 的 `iss` 和 `sub`）、算法、证书 CN、有效期、SHA-256 指纹和保存的令牌权限。安装列表已加载且当前可签发权限不同于保存值时，卡片另列「实际可签发」。转发订阅和 Actions 规则的仓库输入不变。

## 令牌权限

新增或编辑客户端时，表单「令牌权限」逐项列出可选的 GitHub App 仓库权限：权限名称（中文名和 GitHub 的键名）、一段说明（这项权限能做什么、只读和读写各自的常见用法），以及「读写／只读／禁止」三选一。兑换出的令牌只带选为读写或只读的权限；禁止的不会出现在令牌里。可选的权限和限制：

| 权限 | 可选级别 | 常见用法 |
| --- | --- | --- |
| 元数据 `metadata` | 固定只读 | GitHub 给每个令牌自动附带，不能关闭 |
| 代码内容 `contents` | 读写／只读／禁止 | 只读：读源码、比较提交；读写：推送提交、建删分支和标签、合并 PR |
| Issue `issues` | 读写／只读／禁止 | Issue 与 PR 的评论、标签、指派 |
| Pull Request `pull_requests` | 读写／只读／禁止 | PR 本身、评审、请求评审人 |
| Actions `actions` | 读写／只读／禁止 | 只读：查运行、下载产物；读写：触发、重跑、取消运行 |
| 检查 `checks` | 读写／只读／禁止 | 读写：把外部结论写成 PR 上的一项 Check |
| 提交状态 `statuses` | 读写／只读／禁止 | 读写：给提交写 CI 状态 |
| 工作流文件 `workflows` | 读写／禁止 | GitHub 只有写这一级；改 `.github/workflows` 时需要 |
| 合并队列 `merge_queues` | 读写／只读／禁止 | 读写：把 PR 加入或移出合并队列 |
| 部署 `deployments` | 读写／只读／禁止 | 外部发布系统回报部署状态 |
| Pages `pages` | 读写／只读／禁止 | 触发 Pages 构建、改设置 |
| 讨论区 `discussions` | 读写／只读／禁止 | 发帖、回复 |

仓库管理、Secrets、Webhook 设置等高风险权限不提供。除元数据外至少要选一项。新客户端默认选择 Issue 与 Pull Request 读写；在加入权限配置之前保存的客户端也沿用这个默认选择，但实际签发仍受安装上限限制。「恢复默认权限」恢复默认选择并按当前上限收窄。

权限级别按「无 < 只读 < 读写」取更低的一级，安装没有的键视为无；`metadata` 固定只读，`workflows` 不是 write 就视为无。上限是客户端实际可用仓库所属的未暂停安装权限交集；未选仓库时按 `SDBOT_REPOS` 计算。高于上限的单选项禁用，切换仓库时同步更新。保存的是客户端选择与这个上限的交集；兑换时再次按当时的安装权限收窄，响应与发放记录都写实际申请值。旧客户端不在启动时扫表改写。

例如客户端选择 issues:write、pull_requests:write、merge_queues:read，但安装只有 issues:read、pull_requests:read，实际保存和申请为 metadata:read、issues:read、pull_requests:read，不申请 merge_queues。除 metadata 外交集为空时，保存 422、兑换 503，不向 GitHub 申请只有元数据的客户端令牌。想增加实际可用权限，仍需在 App 设置增加权限并由安装组织批准。

管理接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /admin/api/callers` | 客户端列表，以及权限目录 `permission_catalog`（名称、说明、可选级别）和新客户端的默认权限 `default_permissions` |
| `POST /admin/api/callers`，`PUT`／`DELETE /admin/api/callers/<id>` | 新建、修改、删除；正文可带 `permissions`（`{"issues": "write", "contents": "read", "workflows": "none"}` 这样的权限名到 `write`／`read`／`none` 的映射），新建时不带则用默认，修改时不带则沿用原选择，再按当前安装上限收窄；未知权限、GitHub 不提供的级别、不可选仓库、或取交集后除元数据外没有权限时返回 422；目录读取失败 503，不修改已有客户端。鉴权、同源 JSON 写入和 405 规则同 [Webhook 转发](webhook-forwarding.md) |
| `GET /admin/api/token-grants` | 已发出的安装令牌记录，只读 |

## 兑换步骤

1. 调用方用私钥签一个 JWT：
   - 算法与证书一致（RS256 或 ES256）；
   - `iss` 和 `sub` 都是客户端 ID，`aud` 为 `sdbot:caller`；
   - 包含 `exp`、`iat`、`jti`，`exp - iat` 不超过 600 秒。
2. 发送 `POST /caller/v1/token`，带 `Authorization: Bearer <JWT>`，正文只有 `{"repo": "owner/name"}`。
3. Bot 校验以下各项：
   - 用 `jose` 校验 JWT，时钟偏差 5 秒；
   - 证书在有效期内；
   - `jti` 在令牌过期前未用过；
   - 该客户端这一分钟内不超过 60 次；
   - 仓库同时在 `SDBOT_REPOS` 和客户端允许列表中（列表为空时只看 `SDBOT_REPOS`）。

   全部通过后，Bot 查询客户端实际可用仓库的未暂停安装权限，取交集，再与客户端保存的选择取交集，为请求的单个仓库申请令牌。默认选择为 `metadata:read`、`issues:write`、`pull_requests:write`，仍会按安装上限收窄，不默认申请 contents 写权限。
4. 成功时返回 `{ token, expires_at, repository, permissions }`，`permissions` 就是令牌申请的权限。调用方自己用这个令牌访问 GitHub API，到期时间以 GitHub 返回为准，通常约一小时。

| 状态 | 含义 |
| --- | --- |
| 401 | 没有或无效的 JWT、证书不匹配、未知客户端、证书不在有效期、`jti` 重放 |
| 403 | 仓库不在 `SDBOT_REPOS` 或客户端允许列表中 |
| 422 | 正文不是只含 `repo` 的 JSON 对象，或仓库名不合法；`provider` 等其他字段一律拒绝 |
| 429 | 超过每分钟 60 次 |
| 503 | 权限收窄后仍无法签发：除元数据外没有权限、目标未安装或已暂停、上游读取／签发失败，或 App 凭据不可用 |

Bot 不会把安装未批准的权限继续发给 GitHub。保存后的选择仍受当前安装上限约束，组织收回权限后下一次兑换会重新收窄；完全没有所选业务权限时明确返回 503。

## 发放记录

每次成功发出安装令牌，都在同一张表 `token_grants` 记一条，两种来源共用：
- **证书兑换**：来源 `caller`，身份为客户端 ID，仓库为请求的 `repo`，权限记为实际申请的权限，例如默认的 `metadata:read, issues:write, pull_requests:write`；
- **看板 Actions 兑换**（`POST /actions/token`）：来源 `actions`，身份为 `repositoryId:run_id:run_attempt`，身份为「规则名 · 仓库 run 编号#attempt」，并记录 `purpose`、实际仓库和所申请的权限。哪个工作流能换哪些令牌见 [Actions OIDC 临时凭据](actions-oidc.md#访问规则)。

每条记录只包含发出时间、到期时间（GitHub 返回的令牌到期时间，不是 OIDC JWT 的 `exp`）、来源、身份、仓库，以及用途或权限说明。令牌字符串不入库，也不进入管理接口和日志。失败的兑换（401、403、409、422、429、503，以及 Actions 的 502）不记录。写记录失败时，已签发的令牌照常返回。

**保留规则**：
- 发出超过 60 天的记录删除，同时最多保留 1000 条，超出时先删最旧的；
- 每次插入时修剪，现有的五分钟 Cron 也会修剪一次，所以没有新兑换时过期记录同样会消失；
- Webhook 接收路径不读这张表。

管理页「外部调用」下方列出最近 200 条，可看到来源、身份（证书客户端还显示名称）、仓库、用途或权限，以及到期时间和是否仍有效。这些数据在打开该页、切换到该页或点击刷新时读取，没有定时刷新。390px 宽度下每条记录按「名称／数值」逐行显示，不需要横向滚动。

## 实现与验证

实现：
- `src/core/x509.ts`：读取证书类型、有效期和指纹；
- `src/core/permissions.ts`：可选权限目录、说明和校验；
- `src/core/installations.ts`、`src/core/github-app.ts`：权限交集与 App 安装、仓库读取；
- `src/worker/installations.ts`：不占入库锁的管理目录；
- `src/core/caller.ts`：客户端与请求体校验、仓库授权；
- `src/worker/caller.ts`：JWT 校验、`jti`／频率记录和兑换；
- `src/worker/token-grants.ts`：发放记录；
- `src/worker/actions-auth.ts`：Actions 兑换写记录；
- `src/worker/index.ts`：路由和 Cron。

验证：
- `tests-ts/worker-caller.test.mjs` 覆盖：
  - 私钥 PEM 被拒绝；
  - 未选择权限的客户端只申请默认三项，响应为四个字段；
  - 选定的权限决定申请内容和发放记录，「禁止」不进入令牌，元数据始终只读；修改时不带权限沿用原选择并受当前安装上限限制；未知权限、`workflows` 只读、非法级别和只剩元数据都是 422；
  - 加入此配置前保存的客户端按默认权限兑换；
  - 代操作路径返回 404；
  - 错误证书、错误 `aud`／`sub`、过期或过长令牌、缺 `jti`、`jti` 重放、证书过期或未生效均为 401；
  - 仓库不在允许范围时 403，带 `provider` 等字段时 422；
  - 安装目录分页、1000 仓库截断、暂停安装、目录外权限、401／405、读取失败不冒充空列表；
  - 保存 write 收成 read、未安装仓库 422、跨安装交集、空交集拒绝；旧宽权限客户端兑换只申请当前获批权限，响应和记录一致，不扫表改写；
  - 上游签发失败或无所选业务权限时 503，不记录、不签发只有元数据的客户端令牌；
  - Actions 条目的读取、保存、校验、405、跨站 403、非 JSON 415 和未认证 401；
  - 每分钟 60 次后 429；
  - 记录里没有令牌字符串；
  - 超过 60 天（经 Cron）和超过 1000 条的旧记录被删除。
- `tests-ts/actions-auth.test.mjs` 确认 Actions 成功兑换会留下记录，且响应形状不变。
- 浏览器旅程在桌面和 390px 下查看安装账号、权限和仓库，验证复选框、权限上限随仓库变化、不可用旧仓库提示与删除、读取失败禁用修改、证书注册和兑换记录；推进浏览器时钟后无定时请求。
