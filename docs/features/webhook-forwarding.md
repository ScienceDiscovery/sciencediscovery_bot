# Webhook 转发

## 功能

正式 Worker 可以把收到的 Webhook 原样转发给其他 HTTPS 服务。转发订阅在 Access 保护的管理页「转发」中增删改查，最多 20 条。Node 本机运行不提供这项功能。

每条订阅包含：

- **名称**；
- **目标 URL**：只接受 `https`；
- **来源**：`github`、`gitcode` 或两者；
- **事件类型**：可多选 `issue`、`issue_comment`、`pull_request`、`pull_request_review`、`push`、`ping`、`other`。类型是归一化后的 kind，`other` 表示这六类之外、已经归档的事件，例如 `workflow_run`、`installation` 或未识别的事件；
- **签名密钥**（可选）。

## 转发规则

- **只转发已验签并归档成功的投递**：
  - 状态为 `accepted` 的投递会转发；
  - 不在 `SDBOT_REPOS` 范围而记为 `ignored` 的投递也会转发；
  - 验签失败或请求无效的投递不转发；
  - 同一 delivery id 的重复投递只转发第一次。
- **发送时机**：在归档事务提交之后，用 `waitUntil` 在后台发出，Webhook 的响应不等待转发。
- **请求格式**：方法为 `POST`，正文是收到的原始字节，`Content-Type` 沿用来源请求。每次都带：
  - `X-Sdbot-Provider`；
  - `X-Sdbot-Event`：归一化后的 kind；
  - `X-Sdbot-Delivery`：平台 delivery id，没有时用记录 id。
- **签名**：设置了密钥时，对原始正文做 HMAC-SHA256，十六进制摘要放在 `X-Hub-Signature-256: sha256=<hex>`。
- **超时与重定向**：单次超时 5 秒，不跟随重定向，3xx 记为失败。
- **不重试**：目标失败、超时或被拒绝时，Webhook 仍按来源平台原来的成功状态确认，转发也不会再重试。
- **目标地址检查**：只接受 `https`，URL 中不能带用户名或密码。以下目标会被拒绝：
  - `localhost`、`*.localhost`、`*.local`、`*.internal`，以及 `metadata.google.internal` 等云元数据主机名；
  - 字面 IP 落在回环、私网（10/8、172.16/12、192.168/16）、CGNAT 100.64/10、链路本地（含 169.254.169.254）、0/8、组播或保留段的主机；
  - IPv6 的 `::1`、`fc00::/7`、`fe80::/10`，以及映射到上述 IPv4 段的地址。

  `https://2130706433/` 这类整数写法会先被 URL 解析规范为点分地址再检查。保存时和每次发送前都会检查。主机名的 DNS 解析由 Cloudflare 出站完成，Worker 无法在发送前解析名称，因此这里只检查字面地址。
- **存储内容**：不再另存 Webhook 正文。每条订阅只保存配置和最近一次结果：时间、delivery id，以及 HTTP 状态或错误摘要（`HTTP 500`、`redirect not followed (HTTP 302)`、`timed out after 5 s`、`network error`）。

## 密钥与可见范围

签名密钥保存在 Bot 的 Durable Object 中，只能通过 Access 认证后的 `GET /admin/api/forwards` 读回，用于编辑时核对。它不会进入日志、`/admin/api/status`、`/admin/api/usage` 或 Webhook 响应。

## 管理接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /admin/api/forwards` | 订阅列表（含密钥与最近结果）和上限 |
| `POST /admin/api/forwards` | 新建，成功返回 201 |
| `PUT /admin/api/forwards/<id>` | 修改 |
| `DELETE /admin/api/forwards/<id>` | 删除 |

这些接口先经过 `authorizeAdmin`。写请求还必须满足两点，用来防止跨站写入：
- 正文是 `application/json`，否则返回 415；
- 请求带 `Origin` 时必须与管理页同源，带 `Sec-Fetch-Site` 时必须是 `same-origin`，否则返回 403。

参数不合法或已达 20 条时返回 422。集合路径只接受 GET／POST，单条路径只接受 PUT／DELETE，其他方法返回 405。

## 主要实现与成本

- `src/core/forward.ts`：地址检查、参数校验、类型匹配和发送。
- `src/worker/forward.ts`：SQLite 表 `forward_subscriptions`。订阅列表在 Durable Object 生命周期内只读一次并缓存在内存，所以每次 Webhook 不增加 SQLite 读取；只有实际转发时，才会给每条匹配的订阅写一行最近结果。
- `src/worker/index.ts`：在归档成功后调用转发，并提供管理路由。
- 页面没有新增定时器：打开页面、切换到「转发」或点击刷新时才读取。

## 验证

`tests-ts/worker-forward.test.mjs` 在 workerd 中验证：
- 私网和元数据地址被拒绝；
- 来源与类型筛选、转发头与签名；
- 目标返回 500、302 和超时时 Webhook 仍返回 200，并记录各自的结果；
- 验签失败和重复投递不转发；
- 密钥不进入状态和用量接口；
- 20 条上限、405、跨站 403 和未认证 401。

浏览器旅程 `test/journey-cloud-admin.spec.cjs` 在 390px 下完成配置，并确认加载后没有定时请求。
