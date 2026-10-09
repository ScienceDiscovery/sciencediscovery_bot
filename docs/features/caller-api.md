# 外部调用（证书兑换令牌）

## 功能与边界

外部服务可以用自己的证书向 Bot 兑换一个 GitHub 安装令牌，然后自己调用 `api.github.com` 处理 Issue 和 PR。这与看板 Actions 用 OIDC 兑换令牌的方式一样：Bot 只负责签发，不代为执行任何写操作，只支持 GitHub。

调用方自己保管私钥，Bot 只保存它的公钥证书（PEM）。接口 `POST /caller/v1/token` 由正式 Worker 的入口单独处理：
- **故意不在 Cloudflare Access 后面**：调用方是服务，靠证书和 JWT 证明身份；不要给这个路径加 Access，也不要打开 Worker 级 Access；
- **不是 Webhook**：请求不进入投递归档；
- 原来的 `/caller/v1/comments`、`/caller/v1/labels`、`/caller/v1/state` 已删除，返回 404；
- Node 本机运行不提供这项功能。

## 管理客户端

在 Access 保护的管理页「外部调用」中增删改查客户端，最多 20 个。每个客户端记录：
- **名称**；
- **证书**：只接受一个 `CERTIFICATE` 块，PEM 中出现任何私钥都会被拒绝保存。RSA 证书对应 RS256，P-256 EC 证书对应 ES256；
- **允许的仓库**：留空表示 `SDBOT_REPOS` 中的全部仓库。

页面显示每个客户端的 ID（即 JWT 的 `iss` 和 `sub`）、算法、证书 CN、有效期和 SHA-256 指纹。

管理接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /admin/api/callers` | 客户端列表 |
| `POST /admin/api/callers`，`PUT`／`DELETE /admin/api/callers/<id>` | 新建、修改、删除；鉴权、同源 JSON 写入和 405 规则同 [Webhook 转发](webhook-forwarding.md) |
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

   全部通过后，Bot 为该仓库申请安装令牌，权限只有 `metadata: read`、`issues: write`、`pull_requests: write`，不包含 contents 写权限。
4. 成功时返回 `{ token, expires_at, repository }`。调用方自己用这个令牌访问 GitHub API，到期时间以 GitHub 返回为准，通常约一小时。

| 状态 | 含义 |
| --- | --- |
| 401 | 没有或无效的 JWT、证书不匹配、未知客户端、证书不在有效期、`jti` 重放 |
| 403 | 仓库不在 `SDBOT_REPOS` 或客户端允许列表中 |
| 422 | 正文不是只含 `repo` 的 JSON 对象，或仓库名不合法；`provider` 等其他字段一律拒绝 |
| 429 | 超过每分钟 60 次 |
| 503 | GitHub 未签发令牌，常见原因是 App 尚未获批这两项写权限；或 App 凭据未配置 |

**GitHub App 必须在仓库权限里把 Issues 和 Pull requests 设为 Read and write，并由安装所在组织批准。** 批准之前，GitHub 拒绝签发带这些写权限的令牌，兑换返回 503。

## 发放记录

每次成功发出安装令牌，都在同一张表 `token_grants` 记一条，两种来源共用：
- **证书兑换**：来源 `caller`，身份为客户端 ID，仓库为请求的 `repo`，权限记为 `metadata:read, issues:write, pull_requests:write`；
- **看板 Actions 兑换**（`POST /actions/token`）：来源 `actions`，身份为 `repositoryId:run_id:run_attempt`，并记录 `purpose`（`source` 或 `target`）、实际仓库和所申请的权限。Actions 的鉴权、请求体、权限和响应都不变。

每条记录只包含发出时间、到期时间（GitHub 返回的令牌到期时间，不是 OIDC JWT 的 `exp`）、来源、身份、仓库，以及用途或权限说明。令牌字符串不入库，也不进入管理接口和日志。失败的兑换（401、403、409、422、429、503，以及 Actions 的 502）不记录。写记录失败时，已签发的令牌照常返回。

**保留规则**：
- 发出超过 60 天的记录删除，同时最多保留 1000 条，超出时先删最旧的；
- 每次插入时修剪，现有的五分钟 Cron 也会修剪一次，所以没有新兑换时过期记录同样会消失；
- Webhook 接收路径不读这张表。

管理页「外部调用」下方列出最近 200 条，可看到来源、身份（证书客户端还显示名称）、仓库、用途或权限，以及到期时间和是否仍有效。这些数据在打开该页、切换到该页或点击刷新时读取，没有定时刷新。390px 宽度下每条记录按「名称／数值」逐行显示，不需要横向滚动。

## 实现与验证

实现：
- `src/core/x509.ts`：读取证书类型、有效期和指纹；
- `src/core/caller.ts`：请求体校验和仓库授权；
- `src/worker/caller.ts`：JWT 校验、`jti`／频率记录和兑换；
- `src/worker/token-grants.ts`：发放记录；
- `src/worker/actions-auth.ts`：Actions 兑换写记录；
- `src/worker/index.ts`：路由和 Cron。

验证：
- `tests-ts/worker-caller.test.mjs` 覆盖：
  - 私钥 PEM 被拒绝；
  - 换到的令牌只申请上述三项权限，响应只有三个字段；
  - 代操作路径返回 404；
  - 错误证书、错误 `aud`／`sub`、过期或过长令牌、缺 `jti`、`jti` 重放、证书过期或未生效均为 401；
  - 仓库不在允许范围时 403，带 `provider` 等字段时 422；
  - App 未获批时 503 且不记录；
  - 每分钟 60 次后 429；
  - 记录里没有令牌字符串；
  - 超过 60 天（经 Cron）和超过 1000 条的旧记录被删除。
- `tests-ts/actions-auth.test.mjs` 确认 Actions 成功兑换会留下记录，且响应形状不变。
- 浏览器旅程在 390px 下注册证书、兑换令牌，看到列表中的记录，并确认加载后没有定时请求。
