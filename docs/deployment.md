# 部署与配置

## 宿主机

Node.js 22+、npm。Node 验签和 App RSA 签名使用 Web Crypto；Worker 的 Access JWT 校验使用 jose；只有启用外部看板采集器时需要宿主 Python 3。准备本地 `.env`，只在本地填写密钥，然后加载环境：

```bash
npm ci --cache .tmp/npm-cache
cp .env.example .env
# 编辑 .env 后
set -a
. ./.env
set +a
./run.sh start
./run.sh status
# ./run.sh stop
# ./run.sh restart
```

服务只读取环境变量，run.sh 不替你读取 `.env`。run.sh start 自动编译；前台启动可用 `npm run build` 后 `npm start`，开发可用 `npm run dev`。`node dist/node/server.js` 支持 `--webhook-host`、`--webhook-port`、`--admin-host`、`--admin-port`、`--data-dir` 和 `--no-admin`。`.run/` 存宿主 PID／日志，`.data/` 存投递，均不入 Git。

## Docker Compose 与隧道

```bash
docker compose up -d --build
docker compose ps
# 停止时保留数据卷
docker compose down
```

默认只启动 bot，宿主仅发布 `127.0.0.1:8791` 和 `127.0.0.1:8792`。容器内监听 0.0.0.0，Compose 的 loopback 发布边界与管理端 Cf-* 拒绝共同保护管理数据。镜像以非 root 用户运行，命名卷 bot-data 挂载为 `/data`。停止时不要附加 `-v`，以免删除投递历史。

启用 Cloudflare Tunnel 时，在本地 `.env` 设置真实 `CLOUDFLARE_TUNNEL_TOKEN` 和 `COMPOSE_PROFILES=tunnel`，然后再次 up。bot 健康后 cloudflared 才启动。Cloudflare 中的服务目标必须是 `http://bot:8791`，Webhook URL 是 `https://<公开域名>/webhook/github`；永远不能转发 bot:8792 或宿主管理端口。隧道由账号持有人创建／配置，本项目不代建远端 App 或隧道。

可选静态发布使用[看板更新文档](features/board-publication.md)中的第二份 compose 文件；没有发布凭据时保留基础 compose。

## 核心配置

本文其余步骤面向 Node／Compose。Workers 通过 `npm run workers:local` 在隔离目录启动，持久存储和 Actions 配置见 [Workers 指南](features/workers.md)；现有数据卷不会自动迁移。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| SDBOT_GITHUB_WEBHOOK_SECRET | 无 | App 和普通 GitHub Webhook 共用密钥 |
| SDBOT_GITCODE_WEBHOOK_SECRET | 无 | GitCode 签名／密码模式使用的密钥 |
| SDBOT_WEBHOOK_SECRET | 无 | 平台专用密钥未设置时的回退 |
| SDBOT_WEBHOOK_HOST / PORT | 127.0.0.1 / 8791 | 变量全名 SDBOT_WEBHOOK_HOST、SDBOT_WEBHOOK_PORT；旧 SDBOT_HOST / SDBOT_PORT 兼容 |
| SDBOT_ADMIN_HOST / PORT | 127.0.0.1 / 8792 | 变量全名 SDBOT_ADMIN_HOST、SDBOT_ADMIN_PORT |
| SDBOT_ADMIN_ENABLED | 1 | 设为 0 关闭管理监听 |
| SDBOT_ADMIN_TOKEN | 无 | 管理数据需要 Bearer，见[管理认证](features/admin-panel.md) |
| SDBOT_ALLOW_NON_LOOPBACK | 0 | 仅容器等明确场景允许非 loopback 绑定；镜像已设置 |
| SDBOT_REPOS | 两个跟踪源仓 | 逗号分隔；空值／空白不放开范围，见[接入范围](features/webhook-ingestion.md) |
| SDBOT_MAX_BODY_MB | 25 | 最大接收正文 MiB，超限保存前缀并标记 |
| SDBOT_DEDUPE_WINDOW | 2000 | 记忆的平台 delivery 数量 |
| SDBOT_DATA_DIR | .data，容器 /data | 私有投递与队列目录 |
| SDBOT_RUN_DIR | .run | 宿主脚本 PID／日志目录 |
| SDBOT_LOG_LEVEL | INFO | 进程日志级别 |
| SDBOT_BOARD_EXECUTION | 宿主 local；Compose 扩展 github_actions | 仅触发 Actions，或兼容本地 Python 采集 |
| SDBOT_BOARD_TARGETS | 空 | 源仓 → Pages 仓 JSON 映射 |
| SDBOT_GITHUB_APP_ID | 无 | App ID 或 Client ID，用于发布身份 |
| SDBOT_GITHUB_APP_PRIVATE_KEY | 无 | App RSA PEM 私钥，支持字面 \n 换行，只在本地提供 |
| SDBOT_BOARD_GITHUB_TOKEN | 无 | 兼容静态令牌模式，与 App 模式互斥 |
| SDBOT_BOARD_SOURCE_DIR | 同级 github_status_board | 宿主 publish.py 所在目录 |
| SDBOT_BOARD_SOURCE_DIR_HOST | ../github_status_board | Compose 只读挂载的宿主路径 |
| SDBOT_BOARD_DEBOUNCE / REFRESH | 20 / 3600 秒 | 全名 SDBOT_BOARD_DEBOUNCE、SDBOT_BOARD_REFRESH；下限 1 / 60 秒 |
| CLOUDFLARE_TUNNEL_TOKEN | 无 | tunnel profile 的连接凭据 |

Compose 仅传入 compose 文件中显式声明的环境变量；其余参数需要调整 Compose environment 或使用宿主模式。环境变量、`.env`、数据卷和密钥不进入仓库或文档，不要输出完整渲染后的 Compose 配置来排障。管理状态仅返回密钥是否配置，不返回值。

## 运行检查

公开健康检查为 `GET http://127.0.0.1:8791/healthz`；管理面板为 `http://127.0.0.1:8792/`。Webhook 端口访问 /api/status、/api/events、/api/listeners 应为最小 404，管理端带 Cf-* 应为 403。配置了管理口令时数据接口需认证。

TypeScript 镜像仍保留 Python 3，仅供单独挂载的看板采集器使用；接收服务及 App 签名不再执行 Python。升级时保留原数据卷，重建并重启 bot，再检查健康和投递详情；旧档案和队列会直接恢复。Cloudflare Workers 的验证与后续部署条件见[运行环境说明](features/typescript-runtime.md)。更改业务前核对监听点页是否反映实际订阅；监听器注册、远端事件订阅与发布凭据是三项不同配置。
