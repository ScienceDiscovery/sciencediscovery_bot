# Webhook 接入与验签

## 功能与公开接口

GitHub App 与普通组织／仓库 Webhook 共用 `/webhook/github`，不要求 App ID、installation、私钥或 PAT。组织无法安装 App 时可使用普通 Webhook。GitCode 使用 `/webhook/gitcode`；`/webhook` 根据请求头识别平台。

公开端口默认 8791，仅提供上述三个 POST 路径和 `GET /healthz`。健康响应为 `{"ok": true}`；投递响应只包含 ok、delivery_id、ping 的 pong 或简短 error。面板、监听点、事件历史、配置、路由和本地部署信息不对该端口开放。

## 验签和解析

配置来自环境变量，具体见[部署指南](../deployment.md)。GitHub 每个实例共用一个 Webhook secret，App 与普通 Webhook 需使用相同值。不同密钥的来源应另行隔离部署。

- GitHub：使用原始请求字节计算 HMAC-SHA256，对比 `X-Hub-Signature-256`；不接受 SHA-1 替代。
- GitCode：支持 `X-GitCode-Signature-256` 的 hex／base64 摘要或 `X-GitCode-Token` 密码；有签名头时优先验签。
- 对应平台未配置密钥时保留本地 unsigned 模式，启动会提示，管理状态可查看；公网部署必须配置密钥。
- 先验签，再解析 JSON 对象或 `application/x-www-form-urlencoded` 中的 payload。签名不匹配／缺失返回 401，解析错误返回 400。

默认请求上限 25 MiB。超限返回 413，已接收的上限内前缀仍保存并标记不完整。错误路径、坏请求和错签均进入[投递归档](webhook-history.md)，不执行业务。

## 范围与统一事件

默认只处理两个 GitHub 仓库：`openJiuwen-ai/sciencediscovery` 和 `ScienceDiscovery/sciencediscovery`。`SDBOT_REPOS` 未设置、空白或只有逗号时仍采用这两个仓。其他仓、同名 GitCode 仓以及无仓库的非 ping 事件只记录并回 200，不触发业务。仓库匹配不区分大小写。

适配器把平台 payload 转成统一 Event：provider、delivery_id、kind、action、repo、number、title、url、sender、merged、labels、ref、extra 与原始 payload。GitHub closed + merged=true 和 GitCode merge 均表示 `pull_request.merged`。未知事件使用 `unknown.<原始事件名>`，无监听点时照常 2xx 记录；新增业务可订阅，见[事件总线](event-bus.md)。

## 配置来源

在组织／仓库的 Webhook 设置中填写 `https://<公开域名>/webhook/github`、JSON 或表单格式、与本地一致的 Secret，并选择需要的 Issue、PR、评论、push、构建和版本等事件。App 也使用同一入口，但需要安装到目标源仓，并配置对应读取权限及事件订阅。保存后用 ping／Recent Deliveries 验证，再从管理面板查看请求和响应。添加权限与订阅是来源平台的操作，bot 不代建 App。

GitCode Webhook 可选签名或密码模式，配置同样对应本地密钥；当前默认业务范围仅覆盖上述两个 GitHub 仓，GitCode 投递仍可验签和归档。

实现：`src/core/signature.ts`、`events.ts`、`pipeline.ts`、`http.ts` 和 `src/node/server.ts`。验证：`tests-ts/core.test.ts`、`archive-http.test.ts`、`workers.test.ts`。Node 接收器拒绝 Transfer-Encoding，HTTP 解析器拒绝的非法 Content-Length 会记录坏请求；已开始读取的中断正文尽量保存收到的前缀。
