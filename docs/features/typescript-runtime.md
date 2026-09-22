# TypeScript 与运行环境

## 功能与当前部署

Bot 的接收服务、GitHub／GitCode 适配、签名验证、事件总线、请求归档接口、管理 API、重放工具、App 身份与发布队列均使用 TypeScript。生产运行入口是 Node.js 22+，继续由 Docker Compose 与 cloudflared 部署。管理界面仍使用已有静态 HTML，API 和交互保持兼容。

核心代码可以在 Cloudflare Workers 的 workerd 运行时执行，无需 `nodejs_compat`。`src/worker/index.ts` 是独立 Worker 入口，使用 SQLite Durable Object 与 R2 归档、持久 Alarm 调度，通过 GitHub Actions 执行 Python 采集器。仓库提供本地模拟器和 dry-run 检查；云资源、旧档案迁移和云端管理访问仍需在正式切换前完成，见 [Workers 指南](workers.md)。不能把测试用内存存储当成线上归档。

## 代码边界

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `src/core/config.ts`、`events.ts` | 配置解析、仓库范围和统一事件 | 普通 TypeScript |
| `src/core/signature.ts`、`github-app.ts` | HMAC、RS256、安装令牌 | Web Crypto、Fetch；支持 PKCS#1／PKCS#8 PEM |
| `src/core/bus.ts`、`pipeline.ts` | 实际订阅注册、分发、验签和去重 | Archive 接口；按投递串行检查和提交 |
| `src/core/http.ts` | 公开协议、管理 API 与重放 | 标准 Request／Response／Headers |
| `src/core/archive.ts` | 脱敏、记录格式、计数 | 标准 Web API；无文件系统调用 |
| `src/core/board.ts` | 合并发布、恢复、重试与双仓隔离 | StateStore 与 Publisher 接口 |
| `src/node/server.ts`、`archive.ts` | 双 TCP 监听、请求帧边界、JSONL／正文落盘 | Node HTTP／文件系统 |
| `src/node/board.ts` | 原子保存队列，调用外部采集器 | Node 文件系统／子进程 |
| `src/worker/` | 完整投递归档、SQL 索引和去重、持久刷新调度 | R2、SQLite Durable Object、Alarm |
| `src/core/actions.ts` | App 触发目标仓 collect.yml | Fetch；只申请目标仓 Actions 写令牌 |
| `src/node/replay.ts` | fixture CLI、签名和管理员查询 | Node CLI／文件系统，复用核心签名 |

核心统一入口为 `src/core/index.ts`。新增业务仍注册到 EventBus；不向 HTTP 层堆叠业务分支。每个处理器收到独立事件副本，避免某个扩展修改后污染其他处理器和归档；慢任务必须先持久化再返回。串行投递检查可阻止单进程内并发重复触发，但进程崩溃、重放和跨实例部署仍需要业务幂等。

## 现有数据与配置兼容

沿用 `SDBOT_*` 配置、8791／8792 端口以及同一数据卷。旧 `events.jsonl`、payloads、deliveries、旧记录 ID、去重窗口与各看板 `board-publication.json` 均继续读取；不清空历史，不自动改写旧记录。旧记录缺失响应时继续显示“未保存”。

Node 使用与原实现一致的 UTF-8 原始字节验签和归档。新响应使用紧凑 JSON，归档保存其实际发送正文；客户端应解析 JSON，不依赖空格格式。时间戳使用带 UTC 时区的 ISO 8601，管理界面照常按浏览器时区显示。管理 JSON 字段和公开面的最小响应保持兼容。

Bot 不依赖 Python 或 cryptography；可选看板采集器属于独立的 github_status_board 项目。Node／Compose 以 Python 子进程运行，Workers 适配则触发看板仓 Actions 中的 Python 工作流。Compose 镜像保留 Python 仅为该采集器服务，App 私钥、安装令牌申请和发布调度已经迁入 TypeScript。未启用看板发布时，宿主运行只需 Node 与 npm。

## Workers 适配验证与后续部署条件

`npm run test:workers` 使用固定 Miniflare／workerd。测试入口只位于 `tests-ts/support/worker.ts`，使用内存 Archive，校验：实际签名投递、业务分发、去重、最小公开面、Cloudflare 管理头拒绝、PKCS#1 私钥生成的 JWT 可由独立 RSA 验签。构建以 browser 平台打包，禁止引入 Node 内置模块。测试辅助路径不得作为产品接口发布。

`npm run test:worker-adapter` 进一步使用真实 Worker 入口和持久 SQLite／R2 模拟器，验证归档／去重／队列恢复，以及 App 令牌申请和 Actions 触发。GitHub 接口全部模拟，未触发远端发布。Node 与 Worker 使用独立 tsconfig，避免 Cloudflare 与 Node 的全局类型互相覆盖。

生产切换前还需按 [Workers 指南](workers.md)创建云端资源、配置两个看板仓工作流与 Secrets、解决旧档案迁移和受保护管理访问，再验证真实 Actions 和 Pages。Cloudflare Fetch 使用 `redirect: manual` 并检查状态，阻止认证跟随跳转；全局 Fetch 通过箭头调用保持正确接收者。

参考：[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Node.js 兼容范围](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)。当前验证不代表已经完成 Workers 云资源或线上部署。
