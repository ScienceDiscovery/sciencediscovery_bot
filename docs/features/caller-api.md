# 外部调用（证书客户端）

## 功能与边界

外部服务可以请 Bot 代为操作 Issue 或 PR。第一版只有三种操作：发评论、增删标签、打开或关闭。

调用方自己保管私钥，Bot 只保存它的公钥证书（PEM）。每次调用用私钥签一个短期 JWT，放在 `Authorization: Bearer` 中。

接口放在正式 Worker 的 `/caller/v1` 下，由 Worker 入口单独处理：
- **故意不在 Cloudflare Access 后面**，因为调用方是服务而不是浏览器用户，靠证书和 JWT 证明身份；不要给这个路径加 Access，也不要打开 Worker 级 Access；
- **不是 Webhook**：请求不进入投递归档，也不经过事件总线；
- Node 本机运行不提供。

## 管理客户端

在 Access 保护的管理页「外部调用」中增删改查客户端，最多 20 个。每个客户端记录：

- **名称**；
- **证书**：只接受一个 `CERTIFICATE` 块；PEM 中出现任何私钥会被拒绝保存。支持 RSA 证书（对应 RS256）和 P-256 EC 证书（对应 ES256）；
- **允许的操作**：`comment`、`labels`、`state` 的子集；
- **允许的仓库**：留空表示该平台上 Bot 已配置的全部仓库。

保存后页面显示：
- 客户端 ID：JWT 的 `iss` 与 `sub`；
- 算法、证书 CN 和有效期；
- SHA-256 指纹；
- 最近 50 条调用审计。

管理接口为：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /admin/api/callers` | 客户端列表与最近审计 |
| `POST /admin/api/callers` | 新建 |
| `PUT /admin/api/callers/<id>` | 修改 |
| `DELETE /admin/api/callers/<id>` | 删除 |

这组接口的鉴权、同源 JSON 写入和 405 规则与 [Webhook 转发](webhook-forwarding.md) 的管理接口相同。

## 调用

三个接口都是 `POST`，正文为 JSON：

| 路径 | 字段 |
| --- | --- |
| `/caller/v1/comments` | `provider`、`repo`、`number`、`body` |
| `/caller/v1/labels` | `provider`、`repo`、`number`，可选 `add`、`remove`（字符串数组，至少一项） |
| `/caller/v1/state` | `provider`、`repo`、`number`、`state`（`open` 或 `closed`） |

`provider` 为 `github` 或 `gitcode`。

JWT 用 `jose` 校验：
- 算法只接受与证书匹配的 RS256 或 ES256；
- `iss` 和 `sub` 都等于客户端 ID，`aud` 固定为 `sdbot:caller`；
- 必须带 `exp`、`iat`、`jti`，`exp - iat` 不超过 600 秒；
- 时钟偏差沿用 Access 的 5 秒；
- 证书不在有效期内一律拒绝；
- `jti` 在令牌过期前只能使用一次；
- 每个客户端每分钟最多 60 次，超出返回 429。

| 状态 | 含义 |
| --- | --- |
| 401 | 没有或无效的 JWT、证书不匹配、未知客户端、证书不在有效期、`jti` 重放 |
| 403 | 操作不在客户端允许范围内，或仓库不在 Bot 配置或客户端列表中；GitCode 同步未启用时也是 403，并写明原因 |
| 422 | 参数不合法 |
| 429 | 超过每分钟 60 次 |
| 502／503 | 上游拒绝（返回其状态码）或无法连接 |

成功时返回 `{ ok: true, operation, upstream_status }`。

## 平台与权限

- **GitHub**：
  - 只能写 `SDBOT_REPOS` 中的仓库；
  - 每次调用只为该仓库申请一次安装令牌，权限为 `metadata: read`、`issues: write`、`pull_requests: write`，不申请 contents 写权限；
  - `number` 可以是 Issue 或 PR 编号：评论、标签和开关状态都通过 Issues API 完成，删除不存在的标签视为已完成；
  - **GitHub App 必须在仓库权限里把 Issues 和 Pull requests 改为 Read and write，并由安装所在组织批准。** 批准之前，上游会拒绝签发带写权限的令牌，调用返回 503。
- **GitCode**：
  - 只能写当前启用同步的目标仓，即 `SDBOT_GITCODE_SYNC_TARGET`；
  - 使用 `src/core/gitcode-api.ts` 和已有的 `GITCODE_TOKEN`；
  - `number` 指合并请求编号（`!N`），第一版不操作 GitCode Issue；
  - 同步关闭或没有令牌时返回 403，并写明原因。

## 审计与保存的数据

- **审计**：每次通过鉴权的调用只记录时间、客户端 ID、操作、平台、仓库、编号、上游状态和结果（成功、上游失败、未授权），保留最近 200 条。不记录 JWT、证书私钥或评论正文。
- **其他表**：`caller_tokens` 保存 `jti` 直到令牌过期；`caller_rate` 每个客户端一行，记录当前分钟的次数；客户端列表在 Durable Object 内缓存，查找客户端不读 SQLite。

## 实现与验证

实现：
- `src/core/x509.ts`：读取证书类型、有效期和指纹；
- `src/core/caller.ts`：参数校验、授权和上游调用；
- `src/worker/caller.ts`：JWT 校验和 Durable Object 存储；
- `src/worker/index.ts`：路由。

验证：`tests-ts/worker-caller.test.mjs` 用测试 CA 现场签发 RSA 与 EC 证书，在 workerd 中覆盖：
- 私钥 PEM 被拒绝；
- RS256／ES256 调用，以及安装令牌的权限；
- 错误密钥、错误 `aud`／`sub`、未知客户端、过期或过长令牌、缺 `jti`、HS256、`jti` 重放均为 401；
- 证书过期或未生效为 401；
- 未授权操作和仓库为 403，参数错误为 422；
- GitCode 写入，以及同步关闭时的 403；
- 每分钟 60 次限制；
- 审计字段，以及该路径不进入投递归档。
