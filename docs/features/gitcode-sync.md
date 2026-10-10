# GitHub PR 同步到 GitCode 与 CodeCheck 门禁

## 功能

GitHub 源仓的 PR 在创建、推送新提交、重新打开、关闭和合并时，Bot 把它同步成 GitCode 上的一条 MR，让 GitCode 上已有的 CodeArts 流水线（含 OpenLibing CodeCheck）照常运行；GitCode 通过 Webhook 告知 MR 上有新评论或标签变化时，Bot 读取 MR 上的结论，以 GitHub Check 的形式写回该 PR 的 head 提交，作为 GitHub 侧的门禁。同步记录还会发布到看板仓的 GitHub Pages「GitCode 同步」页。

| GitHub 事件 | GitCode 上的动作 |
| --- | --- |
| `pull_request.opened` | 把 PR head 原样推到 `<前缀><PR 号>` 分支（默认 `github-pr/123`），创建 MR，开始等待结论 |
| `pull_request.synchronize` | 推送新 head，更新 MR 标题和正文中的 SHA；旧 head 上仍在等待的 Check 改为 cancelled |
| `pull_request.reopened` | 重新打开 MR；分支已是同一 SHA 时不再传输，重新开始等待结论 |
| `pull_request.closed`（未合并） | 关闭 MR，正文记下「Closed on GitHub」，再删除同步分支；不改 GitCode 默认分支 |
| `pull_request.merged` | 先把 GitCode 默认分支快进到 GitHub 默认分支当时的尖端，再关闭 MR（正文记下「Merged on GitHub」和合并提交），最后删除同步分支；**从不调用 GitCode 合并接口** |

MR 标题形如 `[GitHub #123] <PR 标题> (abc1234)`，正文包含 PR 链接、完整 head SHA、目标分支和「请勿在 GitCode 合并」说明。只同步目标分支在 `SDBOT_GITCODE_SYNC_BASES`（默认 `main`）内的 PR；其他 PR 的创建、关闭和合并都记为「跳过」。

### 合并与关闭

- 合并时推到 GitCode 的是 GitHub 默认分支在处理当时的尖端（经安装令牌读 `GET /repos/{源仓}/branches/{默认分支}`），不是 PR head：squash／rebase 合并后 head 不在 `main` 上；`merge_commit_sha` 只写进 MR 正文，与尖端不一致时以尖端为准。只在 PR 目标分支就是 GitHub 默认分支、且 GitCode 默认分支同名时更新；否则记录原因并跳过这一步。
- GitCode 默认分支只快进：先读 receive-pack 广告里的当前尖端，经 GitHub compare 确认它是新尖端的祖先，再以这个旧 SHA 推送。GitCode 上有 GitHub 没有的提交、或 GitCode 自己以 non-fast-forward 拒绝时，记为错误 `not_fast_forward` 并不再重试，不会改用全零旧 SHA 或强推；这一次仍然关闭 MR、删除同步分支，记录写明默认分支未更新。
- 删除同步分支用 receive-pack 把广告里的旧 SHA 更新为全零，不带 pack；分支已不存在即算完成。只删除 `refs/heads/<前缀><本 PR 号>`，且它不能是 GitCode 默认分支或任一同步目标分支，否则拒绝并记错误 `unsafe_branch`。
- 三步都可重复执行：重试时默认分支已是尖端就不再推送，MR 已关闭就不再修改，分支已删就跳过。临时错误按退避重试整次处理，最后一次尝试时记为错误后继续剩余步骤。同一合并的重复投递不会再次推送或删除。PR 重新打开时同步分支会重新推送。
- 已写出结论的 Check 保持原样；仍在等待的 Check 记为 cancelled。只处理新代码上线之后到达的关闭和合并事件，不补跑历史事件。

GitHub Check（默认名 `CodeCheck (GitCode)`，标题和摘要为英文）的结果：

| GitCode 上的状态 | Check |
| --- | --- |
| MR 带 `ci-successful`，且同步之后出现过 CI 结果评论 | completed / success |
| MR 带 `ci-failed`，且同步之后出现过 CI 结果评论 | completed / failure |
| 还在跑（`ci-running`）、没有结果，或标签早于本次推送 | in_progress，摘要说明「GitCode has no CodeCheck verdict yet」 |
| 同步后超过 `SDBOT_GITCODE_VERDICT_TIMEOUT`（默认 30 分钟）仍无结论 | completed / timed_out，标题「No CodeCheck verdict from GitCode」 |
| 同步失败且不再重试（如权限不足） | completed / failure，标题「Sync to GitCode failed」 |
| PR 在出结论前被关闭、合并或推了新 head | completed / cancelled |

标签是结论本身；「同步之后由 CI 账号（默认 `openJiuwen-bot`）发出的结果评论」用来证明标签属于这次 head，而不是同一条 MR 上一轮运行留下的。结果评论识别「流水线 … 执行成功／执行失败」；运行中评论「The pipeline(…) is running」之后若没有新结果，仍算进行中。缺少结论永远不会写成 success。

### 何时读取结论

Bot 不轮询 GitCode。每次同步成功后只设一个截止时间：推送时间加 `SDBOT_GITCODE_VERDICT_TIMEOUT`（默认 1800 秒，即 30 分钟）。在截止之前，只有下面的 GitCode Webhook 会让 Bot 读取一次该 MR 的标签和评论：

- 同步目标仓上合并请求的评论（Note Hook，新增和修改都按同一种事件处理），且评论作者是 CI 账号。其他作者的评论不读取 GitCode。
- 同步目标仓上合并请求的更新（Merge Request Hook），且变更字段包含标签。

Webhook 只把对应 PR 的读取时间改成「现在」，由持久队列（Worker 的 Alarm、Node 的 5 秒排空）执行这一次读取；按 MR 编号在全部已保存的 PR 状态中查找分支带同步前缀、当前 head 的 Check 仍在等待的那一条。读到结论就写 GitHub Check；仍无结论就等下一次 Webhook 或截止时间。同一轮流水线的结果评论可能比 `ci-successful`／`ci-failed` 标签早几秒到达：读到结果评论但还没有终态标签时，只再安排一次 30 秒后的读取，之后不再追加。

截止时间到达时再读一次：Webhook 丢失但标签和结果评论其实已经在时，照常写 success／failure；仍无结论才记为 timed_out。读取 GitCode 失败时按 1／5／15 分钟有界退避，用尽后只保留截止时间那一次读取。旧版本按 120 秒轮询时保存的状态，在新版本第一次到期时读取一次：已超过新的截止时间就记为 timed_out，否则把下一次读取改到截止时间。

结论必须属于这次 head。GitCode 合并请求接口返回的 `head.sha` 与本次推送的 SHA 不一致时，再经 git upload-pack 读取 `refs/merge-requests/<MR 号>/head`（流水线检出的就是这个引用）：引用已是本次 SHA 就按本次 head 判定，否则仍算进行中。强推之后，GitCode 接口里的 head 和提交列表可能长时间停在旧值，而 git 引用和流水线早已更新；这条核对避免把这种情况误判成「没有结论」而超时。

### 在 GitHub 上重新运行

在 PR 的 Checks 里对 `CodeCheck (GitCode)` 点「Re-run」，或点「Re-run all checks」，GitHub 只向创建该检查的 App 发送 `check_run.rerequested`／`check_suite.rerequested`；拥有 Checks 写权限的 App 自动收到这两个事件，不需要额外订阅，普通仓库 Webhook 收不到。fork PR 的这两个事件不带 PR 号，Bot 用自己写在检查上的 `external_id`（`gitcode-sync:<PR 号>:<SHA>`）或检查组的 head SHA 找到对应 PR，然后：

- 这个 head 已同步到 GitCode（分支已是该 SHA、MR 存在）：不再推送，也不让 GitCode 重新构建，立即读取一次结论，写在一个新的 check run 里；读到 `ci-successful`／`ci-failed` 和本次同步之后的结果评论就直接给出结论，否则从点击时起重新等待 30 分钟（期间仍由 GitCode Webhook 唤醒）。仍在等待中的检查不会另开新的 run，只立即读取一次。
- 这个 head 没有同步成功（例如推送被拒）：重新排队同步，推送并创建或更新 MR，等 GitCode 构建，从这次推送起计时。
- PR 已关闭或合并、点的是旧 head 的检查、目标分支不在同步范围：不做处理。

GitHub 在重新运行时会把检查组重置为排队，原来的 check run 保持不变，新结论出现在新的 run 上。

## 使用方式

**启用条件**：设置了 `GITCODE_TOKEN`，且 `SDBOT_GITCODE_SYNC_TARGET` 不是 `off`。两者都不设置目标和用户名时，同步到 `openJiuwen/sciencediscovery`，以 `openJiuwen-bot` 推送。**停用方式**：把 `SDBOT_GITCODE_SYNC_TARGET` 设为 `off`（不区分大小写），或不提供 `GITCODE_TOKEN`；两种情况监听点都显示「已停用」并写明原因，启动校验不会因此失败。变量未设置或为空白都按「未设置」取默认值，只有 `off` 表示停用。云端只有正式 Worker（`wrangler.jsonc`）；本地或另建的任何非正式实例都必须设 `off`，否则加上令牌就会同步到正式 GitCode 仓。

1. 准备一个对 GitCode 目标仓有推送分支、创建／更新／关闭 MR、读评论权限的账号及其访问令牌；默认使用 `openJiuwen-bot` 账号。
2. 给 Bot 设置下表变量。令牌只放 Worker Secret 或已忽略的 `.env`，仓库和文档只出现变量名。
3. GitHub App 增加 **Checks: Read and write**，保留 Contents: Read、Pull requests: Read、Metadata: Read，并订阅 **Pull request** 事件；目标组织需批准新权限。重新运行用的 `check_run`／`check_suite` 的 `rerequested` 事件随 Checks 写权限自动送达，不需要再勾选。
4. 看板仓不需要新变量：采集工作流用已有的 OIDC 身份调用同一 Worker 的 `/actions/gitcode-sync` 读取记录。
5. 在 GitCode 目标仓（默认 `openJiuwen/sciencediscovery`）的 Webhook 设置中由人工添加一条 Webhook，Bot 不会自己创建：
   - URL：`https://<正式 Worker 域名>/webhook/gitcode`，域名即 `wrangler.jsonc` 中 `routes` 的自定义域名；内容类型 JSON。
   - 事件：合并请求评论（Note Hook；界面把新增和修改分开时两项都选）、合并请求事件（用于标签变化）。
   - 签名密钥或密码：Worker 优先使用 Secret `SDBOT_GITCODE_WEBHOOK_SECRET`，未设置时回退到 `SDBOT_WEBHOOK_SECRET`。两者都没有时 GitCode 投递一律 401；需要在 Cloudflare 的 Worker Secrets 中添加同名 Secret，值与 GitCode 中填写的一致。文档和仓库只出现变量名。
   - 未配置这条 Webhook 时同步照常进行，但每个 head 要等到截止时间那一次读取才有结论。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| GITCODE_TOKEN | 无 | GitCode 访问令牌，用于 REST 和 git 推送；只从环境读取。未设置时同步停用（原因 `no_token`） |
| SDBOT_GITCODE_SYNC_TARGET | `openJiuwen/sciencediscovery` | GitCode 上开 MR 的仓库 `owner/name`；设为 `off` 时停用同步（原因 `off`） |
| SDBOT_GITCODE_USERNAME | `openJiuwen-bot` | 令牌所属的 GitCode 账号，git 推送的 Basic 认证用户名 |
| SDBOT_GITCODE_SYNC_SOURCE | `SDBOT_REPOS` 只有一个时取它 | GitHub 源仓，必须在 `SDBOT_REPOS` 内 |
| SDBOT_GITCODE_PUSH_REPO | 同目标仓 | 接收分支的 GitCode 仓；与目标仓不同时 MR 的 head 写成 `owner:branch` |
| SDBOT_GITCODE_BRANCH_PREFIX | `github-pr/` | 同步分支前缀；不能等于或位于任何目标分支之下，推送前还会核对 GitCode 默认分支 |
| SDBOT_GITCODE_SYNC_BASES | `main` | 逗号分隔的同步目标分支 |
| SDBOT_GITCODE_CI_BOT | `openJiuwen-bot` | 发 CI 结果评论的 GitCode 账号 |
| SDBOT_GITCODE_CHECK_NAME | `CodeCheck (GitCode)` | GitHub Check 名称；分支保护要求的检查名须与它一致 |
| SDBOT_GITCODE_VERDICT_TIMEOUT | 1800 | 同步后等待结论的秒数（默认 30 分钟），下限 600；到点读一次，仍无结论记为 timed_out |
| SDBOT_GITCODE_WEBHOOK_SECRET | 无 | GitCode Webhook 的签名密钥／密码；未设置时回退 `SDBOT_WEBHOOK_SECRET`，两者都无则 GitCode 投递返回 401 |
| SDBOT_GITCODE_POLL_SECONDS | — | 已取消：按间隔回读的轮询已移除，该变量不再读取，保留旧值不会导致启动失败 |
| SDBOT_GITCODE_MAX_ATTEMPTS | 4 | 临时性失败的同步尝试次数，1–10 |
| SDBOT_GITCODE_AUTH | `header` | GitCode REST 认证方式；`header` 用 `PRIVATE-TOKEN` 请求头，`query` 用 `access_token` 参数 |
| SDBOT_GITCODE_API_URL / WEB_URL | `https://api.gitcode.com/api/v5` / `https://gitcode.com` | 只允许无凭据、无查询串的 HTTPS；测试可用 loopback HTTP |
| SDBOT_GITHUB_WEB_URL | `https://github.com` | git 拉取地址；仅测试需要修改 |

缺凭据只降级、不停服：有令牌且目标不是 `off`，但缺少 GitHub App 凭据（`SDBOT_GITHUB_APP_ID` 与 `SDBOT_GITHUB_APP_PRIVATE_KEY` 任一缺失都算缺）或缺少 GitHub Webhook secret（`SDBOT_GITHUB_WEBHOOK_SECRET`，可由 `SDBOT_WEBHOOK_SECRET` 回退）时，Bot 照常启动，Webhook 接收、看板和管理页继续服务，只有同步不运行。管理端状态、`/api/gitcode-sync` 和 `/actions/gitcode-sync` 返回 `enabled: false`、`reason` 与 `reasons`；`reason` 用逗号连接全部稳定代码，两项都缺时为 `no_github_app,no_webhook_secret`。四个代码含义：`no_token` 没有令牌，`off` 目标设为 off，`no_github_app` 缺 App 凭据，`no_webhook_secret` 缺 GitHub Webhook secret；没有令牌或设为 off 时只报这一项。监听点说明列出全部缺失项，看板「GitCode 同步」页用中文显示同样的原因。目标仓名、分支前缀、地址等写错仍属配置错误，Bot 拒绝启动（Worker 返回 503）。

## 主要实现

- `src/core/gitcode-sync.ts`：暂存规则、单步工作、结论判定、记录与公开快照。监听器 `gitcode_sync.on_pull_request` 只把每个 PR 的「最新期望状态」写入持久队列并立即返回；同一动作和 head 的重投为 `duplicate`，`updated_at` 更旧的事件为 `stale`，上次失败后的重投会重新排队（手动重试入口）。监听器 `gitcode_sync.on_codecheck_event` 只接收 provider 为 GitCode、仓库为同步目标的 `issue_comment.created` 与 `pull_request.edited`，把匹配 PR 的读取时间改成现在，本身不调用 GitCode。
- `src/core/config.ts` 的 `tracks()`：同步启用时，同步目标仓的 GitCode 投递进入事件总线；其他 GitCode 仓仍只归档。目标仓不加入 `SDBOT_REPOS`，看板监听仍只收 GitHub。
- `src/core/git-http.ts`：基于 Fetch 和流的 git smart-HTTP。向 GitHub upload-pack（协议 v2）要 PR head 的自包含 pack，原样流式写入 GitCode receive-pack，不解析、不整包缓存，也不变基，因此 GitCode 上的提交 SHA 与 GitHub 一致。`have` 取 GitCode 现有分支顶端和目标分支近 100 个提交；分支已是该 SHA 时只读一次广告、不传输。
- `src/core/gitcode-api.ts`：GitCode REST v5（仓库、分支、MR 列表／创建／更新／详情、MR 提交数、评论）。没有实现合并接口。MR 编号（`!N`）取 `number` 或 `iid`，接受 JSON 整数和整数字符串，从不使用全局 `id`；列表中缺编号的条目会跳过；更新响应缺编号时按已知编号再读一次该 MR，只有再读也失败才报错；创建响应缺编号仍算失败。
- `src/core/git-http.ts` 的 `pushCommit({ fastForward })` 与 `deleteRef()`：只快进的推送和不带 pack 的分支删除；`src/core/github-repo.ts` 读 GitHub 默认分支、分支尖端和 compare 结果。
- `src/core/github-checks.ts` 与 `GitHubApp.tokenForSync()`：只申请源仓 Metadata／Contents／Pull requests 读和 Checks 写的安装令牌。已完成的 check run 不会改回进行中；再次等待时新建一条。
- `src/core/redact.ts`：记录、Check 摘要和公开快照里的错误文本先删去令牌、`Authorization`／token 赋值、`user:pass@` URL，再截断。
- Node：`src/node/gitcode-sync.ts` 用 `<数据目录>/gitcode-sync/state.json` 原子落盘，进程内每 5 秒排空到期任务。
- Worker：`src/worker/gitcode-sync.ts` 在同一个 Durable Object 的 SQLite 中保存每个 PR 一行状态与最近 300 条记录。监听器只在内存暂存，归档事务提交时一并写入（与看板待办相同的 outbox）；Durable Object 的唯一 Alarm 取看板与同步两者最早的到期时间。任务领取时加 10 分钟租约，网络调用期间不持有接收锁，完成后再合并到期间新暂存的状态。
- 读取：管理端 `GET /api/gitcode-sync`（Node 本机／Worker 经 Access 的 `/admin/api/gitcode-sync`）；看板采集工作流用 OIDC 身份 `POST /actions/gitcode-sync`，校验规则与 `/actions/token` 相同，只返回本看板源仓的记录，不签发令牌、不进入投递归档。

失败处理：推送被拒、权限不足、仓库或目标分支不存在、MR 已在 GitCode 被合并等记为错误并停止重试；网络错误、5xx、429 按 1／5／15／30 分钟退避重试，每次失败都单独记录，用尽次数后同样标记失败。两边历史分叉时（GitCode MR 的提交数多于 GitHub PR）仍推原始 SHA，记录为错误「GitCode diff 可能包含本 PR 以外的提交」，结论判定照常进行，Check 摘要同样带此警告。提交数先看 GitCode 接口；接口给出的数多于 PR 时以 git 为准：经 git upload-pack 读 GitCode 目标分支尖端，再用 GitHub compare 统计 PR head 比它多出的提交，多于 PR 的提交数才算分叉，报告的也是这个数。强推之后 GitCode 接口可能长时间仍列出旧提交，这一步避免误报；GitHub 不认识 GitCode 尖端（GitCode 目标分支上有 GitHub 没有的提交）时无法确认，保留接口的结果。已标记分叉的 PR 在之后每次读取结论时（GitCode Webhook、截止读取或 GitHub 重新运行）再按 git 复核，确认不分叉就撤销提示、恢复为「已同步」并留一条记录。

## 边界

- PR head 只推到带前缀的非默认分支；GitCode 默认分支只在 GitHub 合并后快进到 GitHub 默认分支尖端，从不强推、不回退。对 MR 只创建、更新、关闭，仍不调用 GitCode 合并接口；关闭和合并都会删除对应的 `github-pr/<号>` 同步分支，不删除其他分支，也不改其他目标分支。
- 快进依赖 GitHub compare 判断祖先关系：GitCode 默认分支上有 GitHub 不知道的提交时，默认分支保持不变，需要人工处理后，后续合并才能继续快进。
- 结论来自 GitCode 上的现有流水线，本功能不运行检查。2026-09-22 起 GitHub `main` 已删除 `.codearts/` 和 `.ci/codearts-*.sh`；若 GitCode 父流水线仍从 MR 的代码树执行这些脚本，基于新 `main` 的 PR 可能得不到结果评论和标签，Check 会一直进行中，直到超时记为 timed_out。上线前需在 GitCode／CodeArts 侧确认流水线能为这类 MR 产出结论。
- 以评论时间判断新旧依赖 GitCode 与 Bot 的时钟，允许 30 秒偏差；CI 评论文案或标签名改变时需要同步修改判定规则和测试。
- GitCode REST 的字段、`PRIVATE-TOKEN` 认证、`state` 取值与跨仓 `owner:branch` 写法按 v5 文档实现，没有对真实 GitCode 验证；git 推送用户名是否必须是令牌所属账号，也需上线时核对。
- Worker 中一次 Alarm 最多处理 5 个到期 PR；首次推送可能传输从共同祖先以来的全部对象，耗时随分叉量增长。
- Bot 只保存每个 PR 的当前同步状态和最近 300 条记录；长期可见的历史由看板仓提交的 `site/data/gitcode-sync.json` 承担。

## 验证入口

- `tests-ts/gitcode-sync.test.ts`：opened／synchronize／reopened／closed／merged（合并推 GitHub `main` 尖端而非 PR head、关闭和合并都删除同步分支、非快进不发全零旧 SHA 且仍关闭和删除、只删本 PR 的前缀分支、重复投递不再推送或删除、重试读取当时的尖端、MR 更新响应缺编号时仍关闭并删除同步分支）、同一投递重放与新投递重复、过期事件、GitCode 临时与永久失败、错误正文脱敏、历史分叉、范围外目标分支、结论规则与配置校验；GitCode Note Hook 与标签变化触发读取、同步后不再定时读取、其他作者／其他 MR／其他仓／未验签的投递不读取 GitCode、30 秒补读只有一次、截止读取补上丢失的 Webhook、默认 30 分钟一次跳到 timed_out、读取失败的有界退避、旧轮询状态的迁移、接口 head 停在旧值时经 `refs/merge-requests/<n>/head` 确认；接口提交数偏多时按 git 判断是否分叉、已有的分叉提示在下一次读取时按 git 撤销；GitHub 重新运行：已同步的 head 在新 run 里直接读取且不再推送、检查组按 head SHA 匹配、同步失败的 head 重新同步、其他检查名／旧 head／未知 PR／已关闭 PR 不处理。fixture 在 `tests-ts/fixtures/gitcode-sync/`。
- `tests-ts/gitcode-api.test.ts`：MR 编号解析（整数、整数字符串、小数／空串／非数字、不用 `id`）、列表中坏条目不影响查找、创建缺编号仍失败、更新缺编号时按编号回读。
- `tests-ts/git-http.test.ts`：用本机 `git http-backend` 搭建分叉的「GitHub」「GitCode」裸仓，验证 SHA 不变、对象连通、重复推送不传输、非快进更新、错误凭据与不安全分支名，以及只快进推送（拒绝回退和从全零创建、服务端 non-fast-forward 拒绝）、分支删除，以及 `remoteRef` 经 upload-pack v2 `ls-refs`（及 v0 回退）读取单个引用。
- `tests-ts/worker-gitcode-sync.test.mjs`：生产 Worker 包在 workerd 中跑完整链路（Webhook → outbox → Alarm → 真实 git 传输 → GitCode Note Hook 唤醒读取并写 success → GitHub 检查组重新运行后在新 run 里再次写 success、不再推送 → 合并后快进 GitCode `main`、关闭 MR、删除同步分支），以及 `/actions/gitcode-sync` 的 OIDC 保护和无凭据输出。

以上测试不访问真实 GitHub、GitCode 或 OpenLibing。
