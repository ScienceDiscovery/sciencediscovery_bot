# Worker 自动部署

## 范围与当前状态

本页说明如何把 Bot 代码仓的更新发布到正式 Worker。看板仓的 `collect.yml` 采集 GitHub 数据，`pages.yml` 发布静态看板，这两条工作流不部署 Bot。

云端只有正式 Worker `sciencediscovery-bot`，配置是 `wrangler.jsonc`，由 Cloudflare Workers Builds 从 `main` 分支发布。原测试 Worker 及其域名、存储和构建连接已删除，`wrangler.test.jsonc` 也已移除，不再有云端测试版本；`develop` 分支停在旧提交，不触发任何部署，不要据此重建测试实例。合入前的验证在本地完成：`npm test`（含 workerd 测试）、`npm run workers:check` 和浏览器旅程，见[验证指南](../testing.md)。Bot 仓没有额外的 GitHub Actions 部署工作流，Wrangler 手动部署仅作维护入口。

## 两种方式

| 方式 | 推送后的执行位置 | 部署授权 | 适用场景 |
| --- | --- | --- | --- |
| Cloudflare Workers Builds（当前使用） | Cloudflare 拉取 GitHub 提交，执行检查和部署命令 | 在 Cloudflare 构建设置中生成或选择 API token | 直接连接正式 Worker，减少维护部署工作流 |
| GitHub Actions | Bot 仓的 runner 检查后调用 Wrangler | GitHub 环境 Secret 中的 Cloudflare API token | 希望在 GitHub 统一管理检查、部署与批准 |

Workers Builds 原生支持 Git 仓推送触发；GitHub Actions 也是官方支持的部署方式。只选一条自动发布链路，避免两套流水线重复发布。[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

## 当前配置：Workers Builds

正式 Worker 的 **Settings → Builds** 已连接 Bot 的 GitHub 仓库（Cloudflare Git 集成，不是业务 GitHub App 的 Webhook）：

| 设置 | 值 |
| --- | --- |
| Git repository | Bot 代码仓 |
| Root directory | 仓库根目录 |
| Production branch | `main` |
| Build command | 见下 |
| Deploy command | `npx wrangler deploy -c wrangler.jsonc` |
| Preview builds | 关闭 |

```bash
npm ci --include=dev && npm run check && npm run build && npm test && npm run workers:check
```

**Build Variables and Secrets** 设置 `NODE_VERSION=22`、`SKIP_DEPENDENCY_INSTALL=1`，按锁文件安装依赖。检查失败时不执行部署；`workers:check` 只对 `wrangler.jsonc` 做 dry-run，不创建远端资源。部署 API token 只需覆盖正式 Worker、其存储绑定与路由；App 私钥和 Webhook secret 留在 Worker 运行时 Secrets，不复制到构建变量。Wrangler 已锁定在 `package-lock.json`，配置的 `name` 须与连接的 Worker 一致。[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[构建镜像与版本](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

合入 `main` 即发布，因此 `main` 应要求 PR 评审，功能分支在合入前完成本地验证。可配置 Build watch paths 跳过纯文档变更，但须覆盖 `src/`、`static/`、`tools/`、`tests-ts/`、依赖锁文件、TypeScript 与 Wrangler 配置等实际输入。[路径过滤](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)

## 如果改用 GitHub Actions

在 Bot 仓新增只针对 `main` 的部署工作流；PR 只做不带部署凭据的检查。仓库的 `production` Environment 配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，并限制可发布分支；Account ID 不是秘密，但公开文档不填写实际值。runner 使用 Node.js 22，先执行相同的安装、检查、测试和 dry-run，再运行 `npx wrangler deploy -c wrangler.jsonc`。改用前先断开 Workers Builds，避免重复发布。[官方接入说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

看板采集使用的 GitHub OIDC → Bot → GitHub App 安装令牌只授权 GitHub 仓库操作，不能部署 Cloudflare；不把 App 私钥复制回 Actions，也不让 Bot 成为自身发布所需的凭据服务。

## 验收与回退

- 在合并提交的 Workers Builds 检查中确认分支／SHA、构建成功和版本 ID；只有构建成功或上传版本不代表已切换流量。
- 健康响应仍为最小 `{"ok":true}`；公开 `/api/status` 保持 404；管理页拒绝未经 Access 认证的访问，令牌兑换拒绝无效身份。
- 发布后核对绑定、业务范围、Secrets 保留和实际采集结果。代码更新不应删除 R2／SQLite、重新初始化 `.sync/` 或清空 `site/`。UI 变更在合入前按[验证指南](../testing.md)跑浏览器旅程，上面的构建命令不包含浏览器组。
- 回退时部署已验证的提交（或在控制台回滚到上一个版本）。涉及 Durable Object／数据结构变更时，先确认旧代码与现存数据兼容；回退代码不等于回退存储。
