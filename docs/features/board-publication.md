# 正式与测试看板更新

## 功能

看板监听收到跟踪源仓的 Issue、PR、评审、merge、push、构建、检查、版本或标签事件后，将对应静态站点更新入队。两个站点分别维护 GitHub Pages 内容，浏览器无需访问 bot 或持有 GitHub 凭据。

| 用途 | 来源 | 目标看板仓 | 站点 |
| --- | --- | --- | --- |
| 正式 | openJiuwen-ai/sciencediscovery | ScienceDiscovery/github-status-board | https://sciencediscovery.github.io/github-status-board/ |
| 测试 | ScienceDiscovery/sciencediscovery | ScienceDiscovery/github-status-board-test | https://sciencediscovery.github.io/github-status-board-test/ |

未配置发布时，BoardUpdater 为 noop，只记录被调用；管理面板监听点显示“占位”。配置完成后使用 MultiBoardUpdater，监听点显示“已启用”及实际源仓范围。该状态仅表示后台发布业务启用，不能代替目标站点的最近成功时间。

## 配置和启动

准备静态看板源码，默认放在 bot 的同级 `github_status_board` 目录；发布器由该项目的 `publish.py` 实现。在 bot 本地 `.env` 配置以下映射及一个实际发布凭据：

```dotenv
SDBOT_REPOS=openJiuwen-ai/sciencediscovery,ScienceDiscovery/sciencediscovery
SDBOT_BOARD_TARGETS='{"openJiuwen-ai/sciencediscovery":"ScienceDiscovery/github-status-board","ScienceDiscovery/sciencediscovery":"ScienceDiscovery/github-status-board-test"}'
SDBOT_BOARD_SOURCE_DIR_HOST=../github_status_board
SDBOT_BOARD_GITHUB_TOKEN=
```

```bash
docker compose -f docker-compose.yml -f docker-compose.board.yml up -d --build
```

凭据需读取源仓 Metadata / Issues / Pull requests / Actions 等数据，并写入目标看板仓 Contents；首次配置 Pages 需目标仓管理权限，设置 gh-pages 根目录。优先使用限定仓库、可轮换的专用凭据。GitHub webhook secret 也必须配置；启用发布时缺少密钥、凭据或 publish.py 会拒绝启动。

宿主机发布配置源码路径使用 `SDBOT_BOARD_SOURCE_DIR`。Compose 的 `_HOST` 路径只用于把源码只读挂入容器 `/opt/github-status-board`。停用发布时去除发布目标配置并使用基础 compose，事件接收与归档继续工作。

旧 `SDBOT_BOARD_REPO` / `SDBOT_BOARD_TRACK_REPO` 单目标配置仍兼容，但不能与多目标映射同时设置。来源须纳入全局允许列表；拒绝重复源、重复目标以及目标同时作为源，防止互相覆盖或发布事件回环。

## 主要实现

`subscriptions.py` 声明监听事件；普通 PR 更新排除 merge，合并由专门订阅处理。MultiBoardUpdater 根据 source 选择一个 StaticBoardUpdater；每个源与目标组合拥有独立目录、队列文件、工作线程、输出目录和重试状态。

默认 20 秒合并事件，单站点发布间隔至少 60 秒；失败按 30～600 秒退避。启动及每小时兜底采集，即使漏收事件也能更新。队列先写盘再返回 queued，进程重启恢复；发布期间新到达的请求保留到下一轮，一站失败不阻断另一站。换目标不会继承旧站点成功状态。

后台以子进程调用 publish.py，最长等待 600 秒，仅传入发布凭据和必要网络环境，不继承 Webhook、admin 或 cloudflared 密钥。成功要求返回提交 SHA，失败只记录错误类别。`board.targets` 分别报告 pending、running、last_success、commit 和 error。提交成功后 Pages 仍有部署延迟。

静态发布器只导出公开源仓与公开目标，非强制原子更新 gh-pages 的站点文件；来源／目标映射也在看板仓校验。Issue、PR、门禁、每日构建、版本测试与 E2E 计数由真实 API／报告采集。缺失、下载超时或不可解析的测试报告保留未知，不用测试文件数替代通过用例数。具体采集和 UI 说明由[看板仓文档](https://github.com/ScienceDiscovery/github-status-board)维护。

## 验证

实现：`sdbot/board.py`、`config.py`、`subscriptions.py`、`docker-compose.board.yml`。测试：`tests/test_board.py` 验证合并、恢复、重试和凭据边界；`test_repository_scope.py` 验证双仓隔离；`test_bus.py` 验证实际注册范围；监听点浏览器旅程验证双目标状态展示。验收自动更新时需核对排队、提交 SHA 和 Pages 可见内容，不能仅以 Webhook 200 作为发布成功。
