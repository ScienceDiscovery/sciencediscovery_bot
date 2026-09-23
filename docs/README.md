# 文档目录

| 文档 | 功能与内容 |
| --- | --- |
| [整体架构与当前状态](architecture.md) | Bot／看板／App／Workers 的职责、数据链路、存储、权限与正式／测试隔离 |
| [Webhook 接入与验签](features/webhook-ingestion.md) | App／普通 Webhook、验签、事件模型、双仓处理范围与公开接口 |
| [投递记录与查看](features/webhook-history.md) | 全量留存、请求与响应详情、历史分页、去重、只读查询 |
| [事件总线与业务扩展](features/event-bus.md) | 订阅注册、匹配规则、异常隔离、新业务示例与监听点清单 |
| [正式与测试看板更新](features/board-publication.md) | 双站点映射、后台队列、持久状态、App 安装凭据与 Actions 发布 |
| [管理面板](features/admin-panel.md) | 事件页、监听点页、管理 API、浏览器时区与访问保护 |
| [TypeScript 与运行环境](features/typescript-runtime.md) | Web 标准核心、Node 适配、Workers 验证与持久化边界 |
| [Workers 与 Actions 采集](features/workers.md) | R2／SQLite 归档、持久调度、本地模拟器、采集工作流与上线准备 |
| [云端只读管理](features/cloud-admin.md) | 同 Worker 鉴权端点、Access 配置、正式／测试隔离与旧档案边界 |
| [部署与配置](deployment.md) | 宿主机、Compose、cloudflared、配置变量与数据位置 |
| [验证指南](testing.md) | TypeScript／HTTP／workerd 和浏览器测试、隔离资源与验收重点 |

## 阅读顺序

先读整体架构了解系统分工；云端运行读 Workers 指南，本机运行读部署指南。排查投递从接入、投递记录和管理面板开始；开发业务从事件总线开始，再阅读对应业务文档。每个特性页同时说明用户行为与主要实现位置。

## 维护方式

独立特性在 `features/` 下维护一份说明，避免将同一套技术细节复制到 README。功能变更、接口／配置调整或行为删除必须同步更新对应文档；新增特性须更新本目录。注册的事件、启用条件和代码中的默认值必须与文档一致。版本号、临时部署状态和一次性验证流水不作为长期功能说明保存。
