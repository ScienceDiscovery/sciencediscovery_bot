# 验证指南

## Python 与 HTTP

在仓库根目录运行，临时数据留在工作区：

```bash
mkdir -p .tmp/tests
TMPDIR="$PWD/.tmp/tests" python3 -m unittest discover -s tests -v
```

测试包含验签、GitHub／GitCode 归一化、merge、事件总线与注册规则、单监听器失败隔离、仓库限制、去重、归档、HTTP 详情／重放、管理访问保护和独立发布队列。HTTP 测试启动自己的 loopback 随机端口，不使用运行中的服务或数据卷。

新增业务至少验证一次应触发和一次不应触发；新增选择条件、启用模式或路由时核对实际注册清单与执行结果。重放生成新 delivery，不能把它当重复投递跳过。

## 管理面板浏览器旅程

```bash
node test/sync-e2e.mjs
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs
```

使用 `test/e2e.package.json` 固定版本，依赖、浏览器、缓存、独立数据和截图均在 `.e2e/`。测试服务使用 18891／18892、一次性密钥和管理口令，显式关闭真实看板发布目标。不能替换为全局 Playwright 或连接线上管理口跑写入测试。

用例覆盖投递 → 详情 → 请求／响应 → 重放、错签和错误路径、历史分页、旧记录、浏览器时区，以及监听点的真实注册清单、搜索筛选、启用／占位／停用、空结果、失败反馈、双看板状态与窄屏布局。UI 修改完成后查看实际桌面与手机截图，核对页面可读、重要内容未裁切、导航可用。

## 本机回放

需要检查运行中的本机 webhook 时，使用 `scripts/replay.py --help` 选择 fixture 和目标 URL，并从环境提供与接收器一致的密钥。回放会留下真实投递记录，业务可能被触发；正式验收优先使用隔离服务和一次性数据，不混入日常部署。

## 提交前

- 文档：核对对应特性、API、配置、启用条件和边界，检查 [docs 目录](README.md)与相对链接。
- 公开面：没有新增管理信息到 webhook 响应；监听列表只由管理端读取。
- 文件：检查 git diff／status，不提交 `.env`、原始投递、密钥、运行日志和测试产物。
- 清理：保存必要验收证据后，只删除本轮 `.tmp/`、`.e2e/` 产物，保留实际部署数据。
