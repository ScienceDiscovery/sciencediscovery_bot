# sciencediscovery_bot

以 Webhook 为入口的 TypeScript 事件总线。支持 GitHub App、普通组织／仓库 Webhook 和 GitCode 接入，保存请求与响应，按订阅更新静态看板。使用 Node.js 22+；核心采用标准 Fetch／Web Crypto，并通过 Cloudflare Workers 运行时验证。

默认只处理 `openJiuwen-ai/sciencediscovery`（正式）和 `ScienceDiscovery/sciencediscovery`（测试）的 GitHub 事件；其他 Webhook 仍完整记录。分析业务当前为占位，静态看板发布需要另外配置凭据。

## 快速启动

```bash
cp .env.example .env
# 编辑 .env，填写 Webhook 密钥；仅使用隧道时再配置其 token 和 profile。
docker compose up -d --build
```

- Webhook：`http://127.0.0.1:8791/webhook/github`（或 `/webhook/gitcode`）。
- 管理面板：`http://127.0.0.1:8792/`，包含“事件记录”和“监听点”两页。
- Cloudflare Tunnel 只能转发 `http://bot:8791`，不能转发 8792。

宿主运行先执行 `npm ci`，加载 `.env` 后运行 `./run.sh start`；停止使用 `./run.sh stop`。配置见[部署指南](docs/deployment.md)。

Workers 本地适配：`npm ci` 后复制 `.dev.vars.example` 为 `.dev.vars`，运行 `npm run workers:local`，使用 18891／18892；默认阻止远端请求。云端归档与 Actions 采集的配置、当前边界见 [Workers 指南](docs/features/workers.md)。

## 文档

[完整目录](docs/README.md) · [接入与验签](docs/features/webhook-ingestion.md) · [投递记录与查看](docs/features/webhook-history.md) · [事件总线与扩展](docs/features/event-bus.md) · [看板更新](docs/features/board-publication.md) · [管理面板](docs/features/admin-panel.md) · [验证指南](docs/testing.md)

新增或修改特性时，同步更新对应文档及目录；仓库维护约定见 [AGENTS.md](AGENTS.md)。
