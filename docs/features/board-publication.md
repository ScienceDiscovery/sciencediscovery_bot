# 正式与测试看板更新

## 功能

看板监听收到跟踪源仓的 Issue、PR、评审、merge、push、构建、检查、版本或标签事件后，将对应静态站点更新入队。两个站点分别向看板仓的 `main/site/` 提交静态文件，再由该仓 GitHub Actions 发布 Pages，浏览器无需访问 bot 或持有 GitHub 凭据。

| 用途 | 来源 | 目标看板仓 | 站点 |
| --- | --- | --- | --- |
| 正式 | openJiuwen-ai/sciencediscovery | ScienceDiscovery/github-status-board | https://sciencediscovery.github.io/github-status-board/ |
| 测试 | ScienceDiscovery/sciencediscovery | ScienceDiscovery/github-status-board-test | https://sciencediscovery.github.io/github-status-board-test/ |

未配置发布时，BoardUpdater 为 noop，只记录被调用；管理面板监听点显示“占位”。配置完成后使用 MultiBoardUpdater，监听点显示“已启用”及实际源仓范围。该状态仅表示后台发布业务启用，不能代替目标站点的最近成功时间。

## 配置和启动

准备静态看板源码，默认放在 bot 的同级 `github_status_board` 目录；发布器由该项目的 `publish.py` 实现。在 bot 本地 `.env` 配置以下映射及 GitHub App 的 App ID 与 RSA 私钥：

```dotenv
SDBOT_REPOS=openJiuwen-ai/sciencediscovery,ScienceDiscovery/sciencediscovery
SDBOT_BOARD_TARGETS='{"openJiuwen-ai/sciencediscovery":"ScienceDiscovery/github-status-board","ScienceDiscovery/sciencediscovery":"ScienceDiscovery/github-status-board-test"}'
SDBOT_BOARD_SOURCE_DIR_HOST=../github_status_board
SDBOT_GITHUB_APP_ID=
SDBOT_GITHUB_APP_PRIVATE_KEY=
```

```bash
docker compose -f docker-compose.yml -f docker-compose.board.yml up -d --build
```

App 必须安装到源仓和目标仓，并获准读取源仓 Metadata / Contents / Issues / Pull requests / Actions / Checks / Commit statuses，写入目标仓 Contents。不同组织各有 installation，不能把源仓安装令牌拿去写另一个组织的仓库。App 不需要日常 Pages 管理权限或 Workflows 写权限。

`SDBOT_GITHUB_APP_PRIVATE_KEY` 填 App 设置页生成的 PEM 私钥，仅存本地 `.env` 或环境变量；单行值可用字面的 `\n` 表示换行，并用单引号包住整个值。App ID / Client ID 均可作为 `SDBOT_GITHUB_APP_ID`。Webhook secret 仅用于接收验签，不能替代 App 私钥。不要把密钥粘贴进聊天、提交或日志。

`sdbot/github_app.py` 用 cryptography 做 RS256 签名，通过 GitHub API 按配置的 repository 查找 installation。每次后台发布及重试均重新换取两个短期安装令牌：源仓令牌仅授予该源仓的读取权限，目标令牌仅授予该看板仓的 Metadata read / Contents write。GitHub 安装令牌通常一小时过期，本地要求剩余有效期覆盖十分钟发布期限；不缓存到磁盘。失败按原队列重试，不回退个人 gh 凭据。

兼容手工部署的 `SDBOT_BOARD_GITHUB_TOKEN`，但它不能与 App ID／私钥模式混用。GitHub webhook secret 仍须配置；启用发布时缺少密钥、凭据、RSA 支持或 publish.py 会拒绝启动。

宿主机发布配置源码路径使用 `SDBOT_BOARD_SOURCE_DIR`。Compose 的 `_HOST` 路径只用于把源码只读挂入容器 `/opt/github-status-board`。停用发布时去除发布目标配置并使用基础 compose，事件接收与归档继续工作。

旧 `SDBOT_BOARD_REPO` / `SDBOT_BOARD_TRACK_REPO` 单目标配置仍兼容，但不能与多目标映射同时设置。来源须纳入全局允许列表；拒绝重复源、重复目标以及目标同时作为源，防止互相覆盖或发布事件回环。

## 主要实现

`subscriptions.py` 声明监听事件；普通 PR 更新排除 merge，合并由专门订阅处理。MultiBoardUpdater 根据 source 选择一个 StaticBoardUpdater；每个源与目标组合拥有独立目录、队列文件、工作线程、输出目录和重试状态。

默认 20 秒合并事件，单站点发布间隔至少 60 秒；失败按 30～600 秒退避。启动及每小时兜底采集，即使漏收事件也能更新。队列先写盘再返回 queued，进程重启恢复；发布期间新到达的请求保留到下一轮，一站失败不阻断另一站。换目标不会继承旧站点成功状态。

后台以子进程调用 publish.py，最长等待 600 秒，仅传入源仓短期令牌 `GITHUB_TOKEN`、目标短期令牌 `GSB_PUBLISH_TOKEN` 和必要网络环境，不继承 App 私钥、Webhook、admin 或 cloudflared 密钥。成功要求返回提交 SHA，失败只记录错误类别。`board.targets` 分别报告 pending、running、last_success、commit 和 error。提交成功后 Pages 仍有部署延迟。

静态发布器只导出公开源仓与公开目标，基于目标 main 的已有 tree 非强制原子更新 `site/` 内的八个站点文件，保留源码与工作流；来源／目标映射也在看板仓校验。Issue、PR、门禁、每日构建、版本测试与 E2E 计数由真实 API／报告采集。缺失、下载超时或不可解析的测试报告保留未知，不用测试文件数替代通过用例数。具体采集和 UI 说明由[看板仓文档](https://github.com/ScienceDiscovery/github-status-board)维护。

## Actions 发布 Pages

目标看板仓需先有 `.github/workflows/pages.yml`，在 Settings → Pages 将 Source 设为 **GitHub Actions**。这是一次性仓库管理操作。工作流监听 main 的 `site/**` 更新，也可手动执行；只上传 site 目录，并使用 Actions 自身的 `GITHUB_TOKEN`（contents read、pages write、id-token write）部署到 github-pages environment。不需要把 App 私钥再复制进 Actions secrets。

Bot 的提交由 App 安装身份完成，可以触发 push 工作流。`board.targets[].last_success` 和 commit 代表提交成功；Pages 是否发布成功还需看 Actions 的 **Deploy dashboard Pages** 运行及站点实际内容。队列不会把 Actions 的部署失败误报为 GitHub 提交失败；部署失败可在目标仓重跑工作流。历史 gh-pages 分支可保留，但不再作为发布来源。

正式和测试仓的 main 含有各自 site 快照，不能把一个站点的整条分支强制覆盖另一个仓。维护共享源码时只同步源码／工作流变更，保留各自 site 数据。两个看板仓产生的 webhook 仍只归档，不触发源仓更新，避免发布回环。

## 验证

实现：`sdbot/board.py`、`config.py`、`subscriptions.py`、`docker-compose.board.yml`。测试：`tests/test_github_app.py` 验证 RSA 签名、过期令牌、安装隔离和最小权限；`tests/test_board.py` 验证合并、恢复、重试和凭据边界；`test_repository_scope.py` 验证双仓隔离；`test_bus.py` 验证实际注册范围；监听点浏览器旅程验证双目标状态展示。验收自动更新时需核对排队、提交 SHA 和 Pages 可见内容，不能仅以 Webhook 200 作为发布成功。
