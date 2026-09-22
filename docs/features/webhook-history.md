# 投递记录与查看

## 功能

每次 Webhook POST 都有独立记录，涵盖成功、未知事件、忽略来源、重复 delivery、错签、坏正文、超限和错误 URL。健康检查及普通 GET 浏览不作为投递记账。在管理面板“事件记录”页可筛选、翻页、查看请求／返回原文。

同一平台 delivery_id 的每次投递使用不同 record_id，保留各次真实返回。业务去重只跳过处理，不删除重复投递的请求。错误签名、无监听点、范围外的投递也会保留。

## 存储实现

下面介绍现有 Node 文件存储。Workers 的同一接口由 `src/worker/archive.ts` 实现：R2 保存完整正文和请求／响应，SQLite Durable Object 提供索引、计数、去重，并将刷新待办纳入同一索引事务。两套存储互不读写，不会自动迁移旧数据，详见 [Workers 指南](workers.md)。

Node 的 FileArchive 写入三个位置：

- `events.jsonl`：摘要索引，包含事件、HTTP 状态、route、hooks、listeners、errors、record_id 和正文／详情文件引用。
- `payloads/YYYY-MM-DD/<record_id>.body`：原始请求字节。
- `deliveries/YYYY-MM-DD/<record_id>.json`：方法、脱敏路径／头、完整性标记、实际响应状态／头／正文等。

默认目录为 `.data/`，容器为持久卷 `/data`。正文／详情先完成写入与 fsync，再追加索引；文件权限为 0600。管理查询跨全部历史分页，不只查内存尾部。启动恢复计数和最近 delivery 去重窗口；去重不等于永久或事务式“恰好一次”，详情见[事件总线](event-bus.md)。

Authorization、Cookie、Token、Secret、Signature、API key 等请求头值脱敏，查询参数值也脱敏；正文保持原始字节以便后续处理，因此归档目录本身按私有数据管理，不进入 Git 或 Pages。非 UTF-8 正文通过 Base64 展示；超限或中断请求保存已接收前缀并说明不完整。存储失败返回 503，不冒充成功入账。现无自动清理策略，部署方需安排容量监测与备份。

## 查看与只读管理

列表和详情的接收时间使用浏览器时区，悬停可查看原时间戳；存档和请求／响应中的时间不改写。详情支持 JSON 格式化与原文切换；历史格式缺少请求头或返回内容时显示“未保存”，不补造旧信息。

管理页面只读，已移除逐条重放按钮和 `POST /api/replay/<record_id>`；旧记录中的重放来源元数据仍可展示。需要重新采集看板时，运行或重跑看板仓 Actions，不依赖历史投递重放。测试 fixture 投递 CLI 继续保留，不能指向正式服务做写入验收。

Worker 的鉴权管理入口查询云端实际接收记录，旧 Node 档案不迁移；原数据卷保留供本机查询。看板的数据源是 GitHub API，进度及已取得指标在看板仓 `.sync/`、`site/`，不依赖旧 Webhook 档案。完整性仍受上游可读范围及测试报告保留期限制。详见[云端只读管理](cloud-admin.md)。

实现：`src/core/archive.ts`、`pipeline.ts`、`http.ts`、`src/node/archive.ts` 和 `server.ts`。`Archive` 接口隔离持久化实现；当前生产使用 JSONL 与文件，旧 Python 格式直接兼容。验证：`tests-ts/archive-http.test.ts`、`core.test.ts` 和 `test/journey-webhook-details.spec.cjs`。
