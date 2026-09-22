# 正式与测试看板更新

## 功能

Bot 验证并归档 Webhook，事件总线匹配跟踪源仓后，合并刷新请求并触发相应看板仓的 `collect.yml`。Python 采集、同步进度、指标缓存、历史分片和静态页面均在看板仓的 Actions 内维护；`pages.yml` 负责部署。

| 用途 | 来源 | 目标仓 |
| --- | --- | --- |
| 正式 | openJiuwen-ai/sciencediscovery | ScienceDiscovery/github-status-board |
| 测试 | ScienceDiscovery/sciencediscovery | ScienceDiscovery/github-status-board-test |

两个源仓之外的 Webhook 仍完整归档，不触发看板。看板仓本身产生的事件也仅归档，避免更新回环。未配置目标时使用 NoopBoard，占位行为不变。

## 配置和启动

本地 `.env` 设置 `SDBOT_BOARD_TARGETS` 源仓到目标仓的 JSON 映射、`SDBOT_GITHUB_APP_ID` 和 `SDBOT_GITHUB_APP_PRIVATE_KEY`，并保留 GitHub Webhook secret。选择 `SDBOT_BOARD_EXECUTION=github_actions` 后启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.board.yml up -d --build
```

Compose 看板扩展默认使用 `github_actions`。宿主环境变量未指定执行方式时仍使用兼容的 `local`；该方式才需要同级看板源码与 Python。Actions 模式不检查或调用本地 `publish.py`，不在 Bot 内下载测试产物或生成站点。

目标仓必须配置变量 `SDBOT_GITHUB_APP_ID`、Secret `SDBOT_GITHUB_APP_PRIVATE_KEY`，且已有 `collect.yml` 与 `pages.yml`。私钥支持多行 PEM 或字面 `\n`，仅保存到已忽略的环境文件与 Actions Secrets；不放入 dispatch 参数、日志或页面。

App 安装到源仓及目标仓。Bot 触发时只申请目标仓 Metadata read / Actions write 的短期令牌。Actions 采集时分别申请源仓 Contents / Issues / Pull requests / Actions / Checks / Commit statuses read，和目标仓 Contents write。不同组织分别取安装令牌；不复用个人 gh 凭据。Pages 部署使用 Actions 的 `GITHUB_TOKEN`（contents read / pages write / id-token write）。

旧单目标 `SDBOT_BOARD_REPO` / `SDBOT_BOARD_TRACK_REPO` 兼容，但不能与多目标混用。来源必须在全局跟踪范围，不能是目标仓。静态 `SDBOT_BOARD_GITHUB_TOKEN` 仅用于 `local` 模式，不能与 App 配置混用。

## 调度和持久状态

`src/core/bus.ts` 声明实际监听；`MultiBoard` 为每个源仓选择独立 `BoardQueue`。队列先保存请求代数，再返回 queued；默认合并 20 秒，最小触发间隔 60 秒，失败按 30～600 秒退避。启动及每小时请求兜底刷新。执行中收到的新代数留到下一轮。

`src/node/board.ts` 在 Actions 模式调用共享 `dispatchCollection`，每站仅保存小型 `board-dispatch.json`（代数、最后触发时间、错误类别）。完整 Webhook 存档独立保留，规则未改变。旧本地采集的 `board-publication.json` 不混用。

管理状态包含 `execution=github_actions`、`pending`、`running`、`last_dispatch` 和 `error`。成功 dispatch 只表明 GitHub 接受请求，`commit` 和 `last_success` 保持 null；采集和部署结果分别看目标仓的 Collect dashboard data / Deploy dashboard Pages。网络异常可能重复触发，不承诺全局恰好一次执行。

Workers 使用持久 Alarm 和事务 outbox 调用同一个 Actions 入口，详见 [Workers 指南](workers.md)。不要同时运行两个 Bot 调度同站点。切换 Node 到 Actions 不会自动部署 Cloudflare Worker。

## 看板仓负责的工作

每次从 main 读取 `.sync/` 和 `site/data/history/`，在请求／时间预算内增量刷新、补历史、重试报告。进度与数据在同一提交内写入；使用准确 checkout 父提交，冲突则失败并从新 main 重试，禁止强推。每小时第 17、47 分钟定时续跑；无站点变化只更新进度，不触发 Pages。

Issue / PR 和 run / attempt 指标分片长期保留；不复制测试日志、截图、trace 或逐用例明细。已有指标不会因产物过期清零。浏览器“历史数据”页可查询全部已采集记录；同步尚未补齐会显示状态。详细契约见[看板采集文档](https://github.com/ScienceDiscovery/github-status-board/blob/main/docs/incremental-history.md)。

`pages.yml` 只上传 `site/`；`.sync/` 不部署到 Pages，但看板仓公开，故它也只能包含公开进度和指标。正式与测试 main 各有数据，维护共享代码时保留双方的 `.sync/` 与 `site/`，不得互相覆盖。

## 验证

`npm run check`、`npm test` 覆盖 Webhook 完整存档、范围／去重、队列恢复、触发失败重试、App 最小权限及管理状态。`tests-ts/board-app.test.ts` 明确验证 dispatch 不伪造提交或发布成功。实际部署验收应核对 Actions 完成、进度与数据同一提交、Pages 完成及站点内容。
