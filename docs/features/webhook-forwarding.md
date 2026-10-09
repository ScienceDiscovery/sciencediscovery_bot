# Webhook 转发

## 功能

正式 Worker 可以把收到的 Webhook 原样转发给其他 HTTPS 服务。转发订阅在 Access 保护的管理页「转发」中增删改查，最多 20 条。Node 本机运行不提供这项功能。

每条订阅包含：

- **名称**；
- **目标 URL**：只接受 `https`；
- **来源**：`github`、`gitcode` 或两者；
- **事件类型**：可多选 `issue`、`issue_comment`、`pull_request`、`pull_request_review`、`push`、`ping`、`other`。类型是归一化后的 kind，`other` 表示这六类之外、已经归档的事件，例如 `workflow_run`、`installation` 或未识别的事件；
- **仓库**（可选）：一组 `owner/name`，最多 50 个，不区分大小写；留空表示所有仓库；
- **附加标头**（可选）：最多 10 个，例如 `Authorization: Bearer <令牌>`，用于目标服务的鉴权；
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
- **仓库过滤**：订阅填了仓库时，只转发这些仓库的投递，按归一化后的仓库名（GitHub 的 `full_name`、GitCode 的项目路径）不区分大小写比较。不在 `SDBOT_REPOS` 范围、记为 `ignored` 的投递，只要仓库在订阅列表里也会转发。没有仓库的投递（例如 App 级别的 `installation`）只发给未填仓库的订阅。
- **附加标头**：原样加入每次转发请求。名称须是合法的 HTTP 字段名，同名（不区分大小写）不能出现两次；值最长 1024 个字符，不能含换行或其他控制字符，防止拼出额外的标头。Bot 自己设置或会改变请求结构与路由的标头不能配置：`Content-Type`、`Content-Length`、`Content-Encoding`、`Transfer-Encoding`、`Host`、`Connection`、`Keep-Alive`、`Upgrade`、`TE`、`Trailer`、`Expect`、`Cookie`、`User-Agent`、`X-Hub-Signature-256`，以及以 `X-Sdbot-`、`Proxy-`、`CF-`、`Sec-` 开头的名称。
- **签名**：设置了密钥时，对原始正文做 HMAC-SHA256，十六进制摘要放在 `X-Hub-Signature-256: sha256=<hex>`。
- **超时与重定向**：单次超时 5 秒，不跟随重定向，3xx 记为失败。
- **不重试**：目标失败、超时或被拒绝时，Webhook 仍按来源平台原来的成功状态确认，转发也不会再重试。
- **目标地址检查**：只接受 `https`，URL 中不能带用户名或密码。以下目标会被拒绝：
  - `localhost`、`*.localhost`、`*.local`、`*.internal`，以及 `metadata.google.internal` 等云元数据主机名；
  - 字面 IP 落在回环、私网（10/8、172.16/12、192.168/16）、CGNAT 100.64/10、链路本地（含 169.254.169.254）、0/8、组播或保留段的主机；
  - IPv6 的 `::1`、`fc00::/7`、`fe80::/10`，以及映射到上述 IPv4 段的地址。

  `https://2130706433/` 这类整数写法会先被 URL 解析规范为点分地址再检查。保存时和每次发送前都会检查。主机名的 DNS 解析由 Cloudflare 出站完成，Worker 无法在发送前解析名称，因此这里只检查字面地址。
- **存储内容**：不再另存 Webhook 正文。每条订阅保存配置和最近 20 次调用结果（含测试，新的在前），每次记录时间、delivery id、事件类型、仓库、耗时，以及 HTTP 状态或错误摘要（`HTTP 500`、`redirect not followed (HTTP 302)`、`timed out after 5 s`、`network error`）。编辑订阅不清空这些结果；删除订阅时一并删除。升级前保存的单条结果作为第一条历史保留，没有耗时、类型和仓库。

## 测试与调用记录

订阅卡片上的「测试」立即向目标发送一条测试请求，用来确认地址、鉴权标头和签名配置可用：
- **请求内容**：方法、地址、附加标头和签名与真实转发相同；`X-Sdbot-Provider` 为 `test`，`X-Sdbot-Event` 为 `ping`，`X-Sdbot-Delivery` 为 `test-<uuid>`，并额外带 `X-Sdbot-Test: 1`。正文是一小段 JSON：`{"test": true, "zen": "...", "subscription": {"id", "name"}, "sent_at"}`；
- **不受筛选限制**：订阅的来源、事件类型和仓库筛选不影响测试；
- **结果**：页面在卡片上显示 HTTP 状态或错误、耗时和时间，以及目标返回内容的开头。返回内容最多读取 4 KB，签名密钥和附加标头的值被替换为 `[REDACTED]`，再按常见令牌格式脱敏，最多显示 500 个字符；它只出现在这次测试的响应里，不保存；
- **记录**：测试结果和真实转发一样计入最近 20 次调用，并标记「测试」。测试请求不是 Webhook，不进入投递归档。

卡片下方的「最近 N 次调用」展开后逐条显示时间、结果、耗时、事件类型、仓库和 delivery id。数据随订阅列表一起读取，测试完成后只更新这张卡片，不另外刷新列表。

## 密钥与可见范围

签名密钥和附加标头的值（常常是令牌）保存在 Bot 的 Durable Object 中，只能通过 Access 认证后的 `GET /admin/api/forwards` 读回，用于编辑时核对。它们不会进入日志、`/admin/api/status`、`/admin/api/usage`、投递记录或 Webhook 响应。管理页的订阅卡片只显示标头名称；编辑表单中的标头值默认遮住，勾选「显示标头值」才显示。

## 管理接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /admin/api/forwards` | 订阅列表（含密钥、最近 20 次结果 `recent` 和最近一次 `last`）、上限 `limit` 与保留条数 `history` |
| `POST /admin/api/forwards` | 新建，成功返回 201 |
| `PUT /admin/api/forwards/<id>` | 修改 |
| `DELETE /admin/api/forwards/<id>` | 删除 |
| `POST /admin/api/forwards/<id>/test` | 发送测试请求，等待目标答复（最多 5 秒）后返回 `{ ok, result, response_excerpt }`；订阅不存在时 404 |

这些接口先经过 `authorizeAdmin`。写请求还必须满足两点，用来防止跨站写入：
- 正文是 `application/json`，否则返回 415；
- 请求带 `Origin` 时必须与管理页同源，带 `Sec-Fetch-Site` 时必须是 `same-origin`，否则返回 403。

参数不合法或已达 20 条时返回 422。集合路径只接受 GET／POST，单条路径只接受 PUT／DELETE，测试路径只接受 POST（正文为任意 JSON，例如 `{}`），其他方法返回 405。

## 主要实现与成本

- `src/core/forward.ts`：地址检查、参数校验、类型匹配、发送和测试请求。
- `src/worker/forward.ts`：SQLite 表 `forward_subscriptions`。订阅列表在 Durable Object 生命周期内只读一次并缓存在内存，所以每次 Webhook 不增加 SQLite 读取；只有实际转发或测试时，才会改写该订阅所在的一行（最近结果放在同一行里），不增加行数。
- `src/worker/index.ts`：在归档成功后调用转发，并提供管理路由。
- 页面没有新增定时器：打开页面、切换到「转发」或点击刷新时才读取。

## 验证

`tests-ts/worker-forward.test.mjs` 在 workerd 中验证：
- 私网和元数据地址被拒绝；
- 来源与类型筛选、转发头与签名；
- 目标返回 500、302 和超时时 Webhook 仍返回 200，并记录各自的结果；
- 验签失败和重复投递不转发；
- 密钥不进入状态和用量接口；
- 20 条上限、405、跨站 403 和未认证 401；
- 按仓库过滤（不区分大小写，含范围外仓库）、附加标头送达目标且不出现在状态、用量和投递接口中，以及非法字段名、含换行的值、保留标头、重复名称和超过 10 个标头时的 422；
- 测试请求带 `X-Sdbot-Test`、附加标头和正确签名，且不受筛选限制；目标返回 500 并回显凭据时，结果为 `HTTP 500`，摘要已脱敏且不超过 500 字符，测试不进入投递归档；
- 最近结果包含真实转发和测试，新的在前，超过 20 条丢弃最旧的，编辑后保留；
- 测试路径的 405、未知订阅 404、跨站 403、非 JSON 415 和未认证 401，被拒绝的请求不会发到目标。

浏览器旅程 `test/journey-cloud-admin.spec.cjs` 在 390px 下完成配置（含仓库和 `Authorization` 标头，值默认遮住、卡片只显示名称），点击「测试」看到 `HTTP 503`、耗时和「返回内容为空」，展开最近调用并在第二次测试后仍保持展开，在 390px 和桌面宽度下都没有横向溢出，并确认加载后没有定时请求。
