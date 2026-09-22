# 验证指南

## TypeScript、HTTP 与 Workers

在仓库根目录运行，缓存和临时数据留在工作区：

```bash
npm ci --cache .tmp/npm-cache
npm run check
npm run build
npm test
# 只验证 workerd 兼容性
npm run test:workers
# 生产 Worker 适配：真实 SQLite/R2 模拟器，GitHub 出站请求使用模拟接口
npm run test:worker-adapter
# 打包检查，不发布
npm run workers:check
```

测试包含验签、GitHub／GitCode 归一化、merge、事件总线与注册规则、单监听器失败隔离、仓库限制、去重、归档、HTTP 详情／只读管理、管理访问保护和独立发布队列、App RSA 签名／安装令牌／最小权限。HTTP 测试启动自己的 loopback 随机端口，不使用运行中的服务或数据卷。

23 组旧版样例的归一化字段和路由结果固定在 `tests-ts/fixtures/expected-events.json`，作为迁移兼容基线；测试不依赖 Python。`workers.test.ts` 在真实 workerd 中执行共享核心，不开启 Node 兼容标记；测试内存归档和辅助查询路径不能用于生产。

`worker-adapter.test.mjs` 直接打包 `src/worker/index.ts`，使用本地持久 SQLite／R2。它验证并发重复投递、记录筛选与移除重放后的无副作用检查、进程重建后的去重与历史、App 最小权限、双仓持久 Alarm 调度以及远端触发失败后的重试；不会访问真实 GitHub 或执行真实发布。Actions 配置另在看板仓执行 `python3 -m unittest discover -s tests -v`；远端 runner／Pages 结果仍需上线阶段验收。

新增业务至少验证一次应触发和一次不应触发；新增选择条件、启用模式或路由时核对实际注册清单与执行结果。管理查询不能新建投递或触发业务；开发 fixture 的新 delivery 不能当作平台重复投递。

## 管理面板浏览器旅程

```bash
node test/sync-e2e.mjs
npm run build
npm run test:e2e
# 复用实际管理旅程验证 Worker 本地适配（与 Node 浏览器组串行运行）
npm run test:e2e:workers
# 同 Worker 云端页面，经测试 Access 代理与真实 workerd
npm run test:e2e:cloud-admin
```

使用 `test/e2e.package.json` 固定版本，依赖、浏览器、缓存、独立数据和截图均在 `.e2e/`。测试服务使用 18891／18892、一次性密钥和管理口令，显式关闭真实看板发布目标。不能替换为全局 Playwright 或连接线上管理口跑写入测试。

用例覆盖投递 → 详情 → 请求／响应 → 拒绝管理写入、错签和错误路径、历史分页、旧记录、浏览器时区，以及监听点的真实注册清单、搜索筛选、启用／占位／停用、空结果、失败反馈、双看板状态与窄屏布局。UI 修改完成后查看实际桌面与手机截图，核对页面可读、重要内容未裁切、导航可用。

`cloud-admin.test.mjs` 验证 Access 签名、issuer／AUD／时效、固定域名、伪造身份、最小公开面和只读端点；JWKS 出站请求用 workerd 模拟端点验证。云端浏览器旅程在 18893 使用临时 RSA 密钥及仅测试服务器的登录代理，密钥只在内存，代码不进部署产物。

## 本机 fixture 投递

需要检查运行中的本机 webhook 时，使用 `npm run replay -- --all` 回放全部 fixture，或指定文件（如 `npm run replay -- fixtures/github/ping.json`）；通过 `--url`、`--admin-url` 选择目标，并从环境提供与接收器一致的密钥。回放会留下真实投递记录，业务可能被触发；正式验收优先使用隔离服务和一次性数据，不混入日常部署。

Actions 触发模式还需验证队列重启后恢复、失败不确认代数，以及 `last_dispatch` 不被误报成 `last_success` 或 Pages 提交。看板仓负责历史续跑与指标缓存的 Python、浏览器及真实 Actions 验证。

## 提交前

- 文档：核对对应特性、API、配置、启用条件和边界，检查 [docs 目录](README.md)与相对链接。
- 公开面：没有新增管理信息到 webhook 响应；监听列表只由管理端读取。
- 文件：检查 git diff／status，不提交 `.env`、原始投递、密钥、运行日志和测试产物。
- 清理：保存必要验收证据后，只删除本轮 `.tmp/`、`.e2e/` 产物，保留实际部署数据。
