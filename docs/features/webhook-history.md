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

Authorization、Cookie、Token、Secret、Signature、API key 等请求头值脱敏，查询参数值也脱敏；正文保持原始字节以便后续处理，因此归档目录本身按私有数据管理，不进入 Git 或 Pages。非 UTF-8 正文通过 Base64 展示；超限或中断请求保存已接收前缀并说明不完整。存储失败返回 503，不冒充成功入账。

### 保留期（Worker）

正式 Worker 的投递档案保留 `SDBOT_ARCHIVE_RETENTION_DAYS` 天（默认 60，可设 1–3650 的整数，不写进 Wrangler 配置）。按对象键里的 UTC 日期（`payloads/YYYY-MM-DD/`、`deliveries/YYYY-MM-DD/`）判断：早于「当前 UTC 时间减保留天数」那一天的日期整日过期，过期日的 R2 正文、R2 详情和 SQLite `deliveries` 索引行一起删除。因此管理页事件列表与详情只剩保留期内的记录；`totals`／`routes` 是累计计数，不随清理减少；`seen` 去重窗口、GitCode 同步状态与记录、凭据兑换记录和看板待办都不属于清理范围。Node 的 `events.jsonl` 与文件归档不清理，部署方仍需自行安排容量监测与备份。

清理挂在 Worker 现有的 5 分钟 Cron 上，每次最多处理 200 行（或 200 个无索引对象），不扫描整张 `deliveries` 表或整个 R2 桶：

- 新投递在写入索引的同一事务里维护 `archive_days`（每个 UTC 日期一行，记该日 seq 的最小、最大值）。过期时只取最早过期日 seq 范围内的至多 200 行，先删 R2 对象，再按这些 seq 删索引行；该日删空后删除对应的 `archive_days` 行。中途失败时索引行仍在，下一次还能拿到同一批键重试。
- 上线前已有的索引行没有 `archive_days`，由 `counters` 中的一次性游标从小到大扫描到上线时的最大 seq：过期行删除，未过期行补进 `archive_days`；游标只前进，每行只读一次，扫描完后不再使用。
- 扫描完成后，再处理 R2 上没有索引的孤儿对象：只用分隔符列出 `payloads/`、`deliveries/` 下的日期目录，按日期前缀分页删除过期日期中的对象，进度记在 `counters`；保留期内的日期目录不会被列出对象。
- 某次运行发现没有任何过期数据时，记下当天 UTC 日期；当天之后的运行只读这一行计数就返回，不查询 `deliveries`。

## 查看与只读管理

列表和详情的接收时间使用浏览器时区，悬停可查看原时间戳；存档和请求／响应中的时间不改写。详情支持 JSON 格式化与原文切换；历史格式缺少请求头或返回内容时显示“未保存”，不补造旧信息。

管理页面只读，已移除逐条重放按钮和 `POST /api/replay/<record_id>`；旧记录中的重放来源元数据仍可展示。需要重新采集看板时，运行或重跑看板仓 Actions，不依赖历史投递重放。测试 fixture 投递 CLI 继续保留，不能指向正式服务做写入验收。

Worker 的鉴权管理入口查询云端实际接收记录，旧 Node 档案不迁移；原数据卷保留供本机查询。看板的数据源是 GitHub API，进度及已取得指标在看板仓 `.sync/`、`site/`，不依赖旧 Webhook 档案。完整性仍受上游可读范围及测试报告保留期限制。详见[云端只读管理](cloud-admin.md)。

实现：`src/core/archive.ts`、`pipeline.ts`、`http.ts`、`src/worker/archive.ts` 和 `src/node/archive.ts`。`Archive` 接口隔离持久化实现；正式 Worker 使用 R2 与 SQLite，Node 使用 JSONL 与文件并兼容旧 Python 格式。验证：`tests-ts/archive-http.test.ts`、`core.test.ts`、`worker-archive-retention.test.mjs`（workerd 中的过期删除、保留、backlog 游标、空闲时不查 `deliveries` 及其他表不受影响）和 `test/journey-webhook-details.spec.cjs`。
