# 仓库约定

## 项目与边界

这是 TypeScript Webhook 事件总线。`src/core/` 使用标准 Fetch／Web Crypto，禁止依赖 Node 内置模块、文件系统或子进程；`src/node/` 实现 Node.js 22+ 双监听、JSONL 持久化、Actions 触发及兼容的外部采集器适配；`src/worker/` 使用 SQLite Durable Object、R2 与持久 Alarm，触发 GitHub Actions 执行采集。`core/pipeline.ts` 负责验签、归一化、仓库范围和去重；`core/bus.ts` 分发并注册业务。投递存档独立于业务是否处理。正式部署使用 Cloudflare Workers；Node／Compose 用于本机运行与回退。

- 默认仅处理 `openJiuwen-ai/sciencediscovery` 与 `ScienceDiscovery/sciencediscovery`；其他 Webhook 仍归档。
- Webhook 路径只提供协议与最小健康响应。Worker 的 `/admin` 及子路径必须先验证 Cloudflare Access 身份，再提供只读管理；Node 管理端仍仅本机访问，隧道不得指向管理端口。管理重放按钮与 API 已移除。
- 看板采集由 Bot 触发目标仓 Actions：正式 Worker 只处理正式源仓，测试 Worker 只处理实验源仓；两套实例分别使用各自的 App ID、私钥和 Webhook secret，看板仓 Actions 使用 OIDC 向对应 Worker 兑换临时安装令牌，不保存 App 私钥；新环境凭据验证通过后才能启用调度。Bot 只保留调度状态，进度、历史与指标缓存保存在各看板仓；完整 Webhook 归档不变。Actions 使用 App 安装令牌读源仓、将进度与 site 原子提交；不同组织分别取令牌。Pages 独立部署，dispatch、提交和部署成功必须区分。
- 分析业务默认占位；看板发布可选启用。新增业务通过订阅注册接入，不在 HTTP handler 或 Pipeline 中堆叠业务分支。
- 监听点页面必须读取实际注册表；不能另写一份展示用的监听清单。
- 慢任务由业务自己的后台队列执行。处理器不能修改传入事件，必须考虑重复投递和重放，不承诺全局恰好一次执行。
- Workers 的归档索引、去重与待刷新状态共用同一个具名 Durable Object。先保存 R2 正文和响应，再原子提交索引、去重与业务待办；不能用实例内存或普通计时器代替持久状态。Actions 触发成功不代表采集、提交或 Pages 成功。
- Worker 管理页面和只读查询与接收端共用部署。必须验证固定 issuer、AUD、签名和有效期，并限定管理域名；不能仅凭 Header 或路径绕过认证调用管理 RPC。本地管理桥不打包进部署产物；管理读取不得调度任务或执行重放。正式使用 `wrangler.jsonc`，测试使用 `wrangler.test.jsonc`，两者不得共用存储或正式 App 私钥。
- `/actions/token` 是独立的凭据兑换协议，不进入投递归档。校验固定 GitHub issuer、audience、不可变仓库／组织 ID、main 分支、固定采集工作流和事件类型；只能签发配置中源仓读取与看板写入权限。令牌和 OIDC 凭据不能进入日志、工作流 inputs 或持久状态。
- GitHub App 请求使用不跟随重定向的 Fetch，并拒绝非成功状态；不能泄漏认证到跳转地址。共享客户端需要通过 workerd 的真实外部请求模拟验证，不能仅用签名测试代表运行环境兼容。

同步两看板仓的共享源码前，必须比较目标 main 与共同基线；目标仓独有修改做三方合并并在该目标源码上验证。只更新本次明确的文件，保留各自 `site/` 和 `.sync/`；各仓 `board-config.json` 只保留自己的源仓映射，不能随共享代码互相覆盖。

## 文档与功能同步

从 [文档目录](docs/README.md) 查找相关特性。每个独立特性使用 `docs/features/` 中的一份文档，写清功能、使用方式、主要实现、边界和验证入口。

[整体架构](docs/architecture.md) 维护跨 Bot、看板、App 与运行环境的职责边界。公开说明使用正式／测试等角色名，不列真实云端实例名称、账号、域名、资源 ID 或成员名单；Wrangler 非秘密部署配置按代码版本管理，凭据只使用 Secrets 或已忽略的环境文件。

新增、修改或删除功能时，必须在同一次修改中更新对应特性文档；新增特性同时更新目录。涉及配置、接口、存储、监听规则、默认行为或操作步骤的修改均适用。删除过时描述，区分实际行为、可选配置和未实现能力。README 只保留项目简介、快速启动与文档入口；详细技术说明放在 docs。此文件只保存长期有效的仓库约定。

## 验证与提交

执行 [验证指南](docs/testing.md) 中与改动对应的测试。事件分发变更要验证匹配／不匹配、异常隔离、去重、归档和公开响应；UI 变更要使用固定 Playwright，在桌面及窄屏检查真实渲染结果。临时文件放 `.tmp/` 或 `.e2e/`，结束后清理本轮产物。

密钥、令牌、原始投递、运行日志和浏览器状态不得提交。凭据仅由环境变量／已忽略的本地 `.env` 提供，不进入文档、公开响应和日志。提交前检查文件清单与差异；不要混入上层仓库文件或无关数据。
