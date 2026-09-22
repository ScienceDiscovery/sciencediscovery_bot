# 事件总线与业务扩展

## 功能

一次有效的 Webhook 可以由多个独立业务监听。业务声明所需的事件、可选平台和仓库范围；总线按注册顺序调用匹配的处理器。新业务不需要修改 HTTP 路由或 Pipeline 的业务分支。管理面板“监听点”页读取同一份实际注册表，展示用途、订阅条件与启用状态。

这是进程内同步分发器，不是外部消息中间件。慢任务应先进入业务自己的持久队列并迅速返回；看板发布已有这种实现。监听清单通过代码注册，当前没有在线编辑、动态导入插件或浏览器开关。

## 处理顺序

1. HTTP 层接收原始字节，Pipeline 验签并解析 JSON／表单。
2. 适配器生成统一 `Event`；Pipeline 检查全局仓库范围及投递去重。
3. Router 将 PR merge 统一为 `pull_request.merged`，协议 ping／installation 不进入业务总线。
4. EventBus 选择所有匹配且启用的监听点，按注册顺序调用；单个异常不阻断其他监听点。
5. 投递归档保存处理结果和实际响应。无匹配监听点仍返回 2xx 并记录；错误签名、非跟踪仓和重复投递不会进入总线。

存档发生在处理之后；总线不提供事务或全局“恰好一次”。进程在业务执行后、存档前退出时可能再次执行业务。处理器应将 Event 视为只读，在外部副作用处实现幂等；回调可能被不同请求线程并发调用。不要仅依赖内存状态防止重复写入。

## 注册一个业务

在业务模块实现回调，在 `sdbot/subscriptions.py` 的组合入口注册；也可在 `server.build()` 构建 Router 后、服务启动前使用其 `bus.subscribe()`。例如：

```python
from sdbot.bus import Listener


def enqueue_notification(event):
    # 在这里写入业务自己的持久任务队列，勿同步执行长耗时网络调用。
    return {"status": "queued"}


bus.subscribe(Listener(
    id="notification.issue_opened",
    business="Issue 通知",
    description="新建 Issue 后排队生成通知",
    routes=("issue.opened",),
    providers=("github",),
    repositories=("openJiuwen-ai/sciencediscovery",),
    handler=enqueue_notification,
))
```

该片段只展示接线位置，注释中的通知队列需要业务实现；框架没有内置通知发送能力。回调接收 `sdbot.events.Event`，可读取 repo、number、delivery_id、kind、action、payload 等字段；返回状态字典或 None。兼容旧 Hook 的字典还可包含 hook / method，以保留归档中的 hooks 字段。

监听点 ID 必须唯一；空条件、无效回调或重复 ID 在注册时失败。启动后新增注册只影响下一次分发，当前投递使用已选定的监听快照；业务回调执行时不持有注册表锁。

| 字段 | 语义 |
| --- | --- |
| id / business / description | 稳定标识、所属业务、用途；同时用于监听点页面 |
| routes | 匹配统一 Event.route，多个规则取“或”；采用 fnmatch 通配规则，如 `issue.*` |
| exclude | 排除路由，优先于 routes；例如普通 PR 更新排除合并路由 |
| providers / repositories | 可选平台／仓库限制；仓库名忽略大小写。空值遵循全局范围，不可扩大 Pipeline 的范围 |
| enabled | false 时仍列在清单中但不调用 |
| mode | active 为实际处理，noop 为已注册占位；占位回调仍会执行并记录。该字段须与实现同步 |

无 action 的 route 是 kind 本身，如 `status`，不会匹配 `status.*`，需显式订阅 `status`。适配器未知的事件 route 为 `unknown.<原始事件名>`，可针对它注册新业务；需要统一字段时再扩展适配器，并补测试与文档。框架不会自动订阅远端 GitHub App 的事件，来源平台也要配置相应投递。

## 内置业务

- 内容分析：Issue opened／edited／reopened，Issue 评论，PR opened／synchronize／reopened／edited／ready_for_review、评审和合并；当前仅记录调用，不调用 LLM 或发评论。
- 看板更新：Issue、评论、PR、评审、merge、push；workflow_run、workflow_job、check_run、check_suite、status、release、create、delete。普通 PR 监听排除 merge，避免一次合并重复更新。
- 未配置发布时，看板监听处于占位状态；启用发布后显示 active，并列出实际来源范围。详见[看板更新](board-publication.md)。

## 可观测性与验证

`GET /api/listeners` 只在管理端列出实际注册表，绝不序列化回调对象、密钥或代码路径。投递摘要中的 listeners 保存监听 ID 与结果状态；errors 仅保存异常类别，避免异常消息夹带凭据。公开响应仍只有协议必要字段。

实现：`sdbot/bus.py`、`subscriptions.py`、`router.py`、`pipeline.py`、`store.py`。验证：`tests/test_bus.py`、`test_router.py`、`test_repository_scope.py` 和监听点浏览器旅程。新业务必须验证应匹配／不应匹配、失败隔离、范围限制、重复投递，并更新对应特性文档及[目录](../README.md)。
