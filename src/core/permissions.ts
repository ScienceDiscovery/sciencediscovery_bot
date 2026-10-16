import { object, type Doc } from './types.js';

/**
 * GitHub App repository permissions that an issued installation token may carry, as chosen on
 * the admin page. Only these are offered: administration, secrets, webhooks and the like are
 * left out on purpose, so a mis-click can never hand them to a token.
 */
export type PermissionLevel = 'read' | 'write';
export type PermissionSet = Record<string, PermissionLevel>;
export interface PermissionInfo {
  key: string; label: string; description: string;
  /** The levels GitHub accepts for this permission; `none` (forbidden) is always possible unless `required`. */
  levels: PermissionLevel[];
  /** GitHub adds metadata read to every token, so it is shown but cannot be changed. */
  required?: boolean;
}

export const PERMISSION_CATALOG: readonly PermissionInfo[] = Object.freeze([
  { key: 'metadata', label: '元数据（Metadata）', levels: ['read'], required: true,
    description: '仓库的基本信息：名称、可见性、默认分支、分支和协作者列表、语言统计。GitHub 给每个令牌自动附带只读，不能关闭，也不需要写。' },
  { key: 'contents', label: '代码内容（Contents）', levels: ['read', 'write'],
    description: '仓库里的文件、提交、分支、标签和 Release。只读：读取源码、比较提交、下载 Release 附件。读写：推送提交、创建或删除分支和标签、发布 Release、合并 PR；看板采集把进度和站点提交到看板仓就靠它。权限很大，外部调用一般禁止。' },
  { key: 'issues', label: 'Issue（Issues）', levels: ['read', 'write'],
    description: 'Issue 及其评论、标签、里程碑、指派。只读：查询 Issue 和评论。读写：新建、编辑、关闭 Issue，发评论，加减标签，指派处理人。PR 的评论、标签和指派也走 Issue 接口，所以给 PR 评论同样需要它。' },
  { key: 'pull_requests', label: 'Pull Request（Pull requests）', levels: ['read', 'write'],
    description: 'PR 本身、评审、评审评论和改动文件列表。只读：查询 PR 状态、评审结论和改动文件。读写：新建、编辑、关闭 PR，提交评审，请求评审人。合并 PR 另外需要代码内容读写。' },
  { key: 'actions', label: 'Actions（Actions）', levels: ['read', 'write'],
    description: '工作流运行、日志、产物和缓存。只读：查询运行结果、下载日志和测试报告等产物（看板采集用它读取测试与覆盖率）。读写：手动触发 workflow_dispatch、重跑或取消运行、删除产物。' },
  { key: 'checks', label: '检查（Checks）', levels: ['read', 'write'],
    description: 'PR 和提交上的 Check（检查运行与检查套件）。只读：读取 CI 检查的结论和摘要。读写：创建、更新自己的 Check，例如把外部系统的结论作为一项检查写回 PR（GitCode 同步就这样写 CodeCheck 结果）。' },
  { key: 'statuses', label: '提交状态（Commit statuses）', levels: ['read', 'write'],
    description: '旧式的提交状态（提交旁的小圆点）。只读：读取第三方 CI 报告的状态。读写：给某个提交写 pending／success／failure 状态，外部 CI 常用。' },
  { key: 'workflows', label: '工作流文件（Workflows）', levels: ['write'],
    description: '允许修改 .github/workflows 下的工作流文件。GitHub 只提供写这一级：推送或合并改动工作流文件的提交时需要，且还要同时有代码内容读写。能改 CI 本身，权限很大，没有明确需要就禁止。' },
  { key: 'merge_queues', label: '合并队列（Merge queues）', levels: ['read', 'write'],
    description: 'main 等分支的合并队列。只读：查看队列里排队的 PR。读写：把 PR 加入或移出合并队列。' },
  { key: 'deployments', label: '部署（Deployments）', levels: ['read', 'write'],
    description: '部署记录和部署状态。只读：查询某个提交部署到了哪个环境。读写：创建部署、更新部署状态，供外部发布系统回报结果。' },
  { key: 'pages', label: 'Pages（Pages）', levels: ['read', 'write'],
    description: 'GitHub Pages 站点。只读：读取站点配置和最近的构建。读写：触发重新构建、修改 Pages 设置。' },
  { key: 'discussions', label: '讨论区（Discussions）', levels: ['read', 'write'],
    description: '仓库讨论区的帖子和评论。只读：读取讨论。读写：发帖、回复、标记答案。' },
]);
const CATALOG = new Map(PERMISSION_CATALOG.map(item => [item.key, item]));

/** Every set lists metadata first and the rest in catalog order; `none` entries are dropped. */
export function normalizePermissions(set: Readonly<Record<string, string>>): PermissionSet {
  const out: PermissionSet = {};
  for (const item of PERMISSION_CATALOG) {
    const level = item.required ? 'read' : set[item.key];
    if (level === 'read' || level === 'write') out[item.key] = level;
  }
  return out;
}

/**
 * Admin input `{ <permission>: "write" | "read" | "none" }`. Unknown names and levels GitHub does
 * not offer are refused; metadata is always read; at least one other permission is required.
 */
export function parsePermissions(input: unknown): { ok: true; value: PermissionSet } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'permissions must be an object of name to write, read or none' };
  const doc = object(input);
  for (const [key, level] of Object.entries(doc)) {
    const item = CATALOG.get(key);
    if (!item) return { ok: false, error: `unknown permission ${key}` };
    // "none" forbids a permission; for metadata it is accepted and ignored, because GitHub always adds read.
    if (level === 'none') continue;
    if (typeof level !== 'string' || !(item.levels as string[]).includes(level)) {
      return { ok: false, error: `${key} can only be ${item.required ? 'read' : [...item.levels, 'none'].join(', ')}` };
    }
  }
  const value = normalizePermissions(doc as Record<string, string>);
  if (Object.keys(value).length < 2) return { ok: false, error: 'choose at least one permission besides metadata' };
  return { ok: true, value };
}

/** What the admin page needs to draw the selectors. */
export const permissionCatalog = (): Doc[] => PERMISSION_CATALOG.map(item => ({ ...item, levels: [...item.levels] }));
