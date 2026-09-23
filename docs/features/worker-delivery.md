# Worker 自动部署

## 范围与当前状态

本页说明如何把 Bot 代码仓的更新发布到现有正式／测试 Worker。看板仓的 `collect.yml` 采集 GitHub 数据，`pages.yml` 发布静态看板，这两条工作流不部署 Bot。

维护者已完成 Cloudflare Workers Builds 控制台接入，Bot 仓的 `develop` 分支也已建立；首次接入及后续发布均需核验提交触发、分支映射与实际部署结果。下面保留接入设置与验收方法。Bot 仓没有额外的 GitHub Actions 部署工作流，Wrangler 手动部署仍可用于维护。运行时继续使用各自已有的 App、Secrets、Durable Object、R2、路由与业务映射。

## 两种方式

| 方式 | 推送后的执行位置 | 部署授权 | 适用场景 |
| --- | --- | --- | --- |
| Cloudflare Workers Builds（当前建议） | Cloudflare 拉取 GitHub 提交，执行检查和部署命令 | 在 Cloudflare 构建设置中生成或选择 API token | 直接连接现有 Worker，减少维护部署工作流 |
| GitHub Actions | Bot 仓的 runner 检查后调用 Wrangler | GitHub 环境 Secret 中的 Cloudflare API token | 希望在 GitHub 统一管理测试、部署与环境批准 |

Workers Builds 原生支持 Git 仓推送触发；GitHub Actions 也是官方支持的部署方式。同一个实例选择一条自动发布链路，避免两套流水线重复发布。[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

## 推荐配置：Workers Builds

1. 在 Bot 仓选择一个测试分支，建议从当前 `main` 建立 `develop`。后续功能先推测试分支、验证测试 Worker 和测试看板，再合入 `main`。不要同时把两实例都绑定 `main` 并据此认为已经建立测试门禁。
2. 在 Cloudflare 控制台选择**已有**测试 Worker，进入 **Settings → Builds → Connect**，连接 Bot 的 GitHub 仓库。按提示授权 Cloudflare 的 Git 集成访问这个仓库；这是部署平台的集成，不是业务 GitHub App 的 Webhook 配置。
3. 按下表设置测试实例；首次连接若立即触发构建，先确认分支、配置路径和部署命令均为测试环境。正式实例再重复连接流程，使用正式一列。

| 设置 | 测试实例 | 正式实例 |
| --- | --- | --- |
| Git repository | 同一个 Bot 代码仓 | 同一个 Bot 代码仓 |
| Root directory | 仓库根目录 | 仓库根目录 |
| Production branch | `develop` | `main` |
| Build command | 下方共同命令 | 下方共同命令 |
| Deploy command | `npx wrangler deploy -c wrangler.test.jsonc` | `npx wrangler deploy -c wrangler.jsonc` |
| Preview builds | 关闭，使用现有独立测试实例 | 关闭 |

控制台的 **Production branch** 表示“为当前这个 Worker 发布正式版本的分支”，因此测试 Worker 可以选 `develop`，并不会部署到正式 Worker。每次发布的版本对应触发构建的提交。[分支控制](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)

共同 Build command：

```bash
npm ci --include=dev && npm run check && npm run build && npm test && npm run workers:check
```

在 **Build Variables and Secrets** 设置 `NODE_VERSION=22`、`SKIP_DEPENDENCY_INSTALL=1`，使用上述 `npm ci` 按锁文件安装依赖。检查命令失败时不继续执行部署；`workers:check` 只打包核对两份配置，不发布另一实例，也不创建远端资源。[构建镜像与版本](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

Wrangler 已锁定在 `package-lock.json`。部署命令必须显式选择环境配置，配置的 `name` 须对应当前连接的 Worker；不要为通过名称校验而把测试配置改成正式实例名称。两份配置都有自己的存储、路由、App ID 和业务映射。[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[名称校验](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/)

4. 在 Builds 中生成或选择部署 API token；需要覆盖该配置实际使用的 Worker、存储绑定与路由操作。App 私钥和 Webhook secret 继续留在各自 Worker 的运行时 Secrets，检查与构建不需要它们，不复制到 Build Variables。构建变量与运行时变量是两套配置。[构建授权与变量](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
5. 先推送测试分支，检查构建日志、提交 SHA 和测试实例的新部署；完成下方验收后再合入 `main`。建议用 main 分支保护要求经过评审，避免绕过测试流程直接推送发布。
6. 接通后可配置 Build watch paths 跳过纯文档变更。需要覆盖 `src/`、`static/`、`tools/`、`tests-ts/`、依赖锁文件、TypeScript 与 Wrangler 配置等实际输入；首次接通可先保留默认触发范围，确认链路后再收窄。[路径过滤](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)

两环境继续使用现有独立实例，不用临时预览替代测试 App 的固定接收入口。两条分支的自动构建彼此独立；合入正式前的真实测试验收需要流程落实，不会由分支名称自动保证。

## 如果选择 GitHub Actions

在 **Bot 仓**新增部署工作流，测试分支和 `main` 分别选择对应配置；PR 只做不带部署凭据的检查。仓库的 `test`／`production` Environments 分别配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，并限制可发布分支。Account ID 本身不是秘密，可用环境 Variable，但公开文档不填写实际值。正式发布需要人工批准时，可使用仓库支持的环境保护规则；不要把两环境放进无条件同时执行的部署矩阵。

runner 使用 Node.js 22，先执行相同的安装、检查、测试和 dry-run，再运行对应的 `npx wrangler deploy -c ...`。每个环境串行发布，避免不同提交互相覆盖；若要先部署测试、验收后再部署同一个 SHA 到正式，可在一条工作流中显式建立作业依赖。官方 `cloudflare/wrangler-action` 也可执行部署。[官方接入说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

看板采集使用的 GitHub OIDC → Bot → GitHub App 安装令牌只授权 GitHub 仓库操作，不能部署 Cloudflare。选择 Actions 发布 Bot 时，仍需上述独立的 Cloudflare 部署授权；不把 App 私钥复制回 Actions，也不让 Bot 成为自身发布所需的凭据服务。

## 验收与回退

- 确认构建使用期望分支／SHA，类型检查、Node／workerd 测试和 dry-run 成功，随后产生新的活动部署；只有构建成功或上传版本不代表已切换流量。
- 健康响应仍为最小 `{"ok":true}`；公开 `/api/status` 保持 404；管理页按 Access 配置状态拒绝匿名访问，令牌兑换拒绝无效身份。
- 测试实例使用测试 App 投递，确认归档、范围过滤、OIDC 采集与测试看板更新；检查正式环境未被该测试部署修改。UI 变更另外按[验证指南](../testing.md)跑浏览器旅程，上面的基础构建命令不包含浏览器组。
- 发布后核对绑定、业务范围、Secrets 保留和实际采集结果。代码更新不应删除 R2／SQLite、重新初始化 `.sync/` 或清空 `site/`。
- 回退先暂停失败版本所在分支的自动发布，再部署已验证的提交。涉及 Durable Object／数据结构变更时，需先确认旧代码与现存数据兼容；回退代码不等于回退存储。
