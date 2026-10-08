import type { Doc, SyncDisabledReason } from './types.js';
export type { SyncDisabledReason };

export const DEFAULT_REPOS = ['openjiuwen-ai/sciencediscovery', 'sciencediscovery/sciencediscovery'];
export const PROVIDERS = ['github', 'gitcode'] as const;
export type Environment = Record<string, string | undefined>;
/** GitHub PR → GitCode MR mirroring and CodeCheck read-back. Enabled only when a GitCode target is set. */
export interface GitCodeSyncConfig {
  /** Empty when enabled. Missing credentials degrade the feature; they never stop the Worker. */
  enabled: boolean; disabled_reasons: SyncDisabledReason[]; source: string; target: string; push_repo: string; branch_prefix: string; bases: string[];
  api_url: string; web_url: string; github_web_url: string; username: string; token: string; auth_mode: 'header' | 'query';
  ci_bot: string; check_name: string; poll_seconds: number; verdict_timeout_seconds: number; max_attempts: number;
}
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const DEFAULT_GITCODE_TARGET = 'openJiuwen/sciencediscovery';
export const DEFAULT_GITCODE_USERNAME = 'openJiuwen-bot';
function gitcodeSync(str: (key: string, fallback?: string) => string, int: (key: string, fallback: number) => number, repos: string[]): GitCodeSyncConfig {
  // Unset (or blank) means the default target; only an explicit `off` turns sync off.
  const raw = str('SDBOT_GITCODE_SYNC_TARGET').trim(), off = raw.toLowerCase() === 'off';
  const target = off ? '' : raw || DEFAULT_GITCODE_TARGET, token = str('GITCODE_TOKEN').trim();
  // Without a token the feature stays off instead of failing startup validation.
  const disabled_reasons: SyncDisabledReason[] = off ? ['off'] : !token ? ['no_token'] : [];
  return {
    enabled: !disabled_reasons.length, disabled_reasons, target, source: str('SDBOT_GITCODE_SYNC_SOURCE', repos.length === 1 ? repos[0] : '').trim(),
    push_repo: str('SDBOT_GITCODE_PUSH_REPO', target).trim(), branch_prefix: str('SDBOT_GITCODE_BRANCH_PREFIX', 'github-pr/').trim(),
    bases: str('SDBOT_GITCODE_SYNC_BASES', 'main').split(',').map(v => v.trim()).filter(Boolean),
    api_url: str('SDBOT_GITCODE_API_URL', 'https://api.gitcode.com/api/v5').trim(), web_url: str('SDBOT_GITCODE_WEB_URL', 'https://gitcode.com').trim(),
    github_web_url: str('SDBOT_GITHUB_WEB_URL', 'https://github.com').trim(), username: str('SDBOT_GITCODE_USERNAME').trim() || DEFAULT_GITCODE_USERNAME, token,
    auth_mode: str('SDBOT_GITCODE_AUTH', 'header').trim() === 'query' ? 'query' : 'header',
    ci_bot: str('SDBOT_GITCODE_CI_BOT', 'openJiuwen-bot').trim(), check_name: str('SDBOT_GITCODE_CHECK_NAME', 'CodeCheck (GitCode)').trim(),
    poll_seconds: int('SDBOT_GITCODE_POLL_SECONDS', 120), verdict_timeout_seconds: int('SDBOT_GITCODE_VERDICT_TIMEOUT', 21600), max_attempts: int('SDBOT_GITCODE_MAX_ATTEMPTS', 4),
  };
}
/** Loopback HTTP is accepted only so tests can stand in for the remote hosts. */
const safeUrl = (value: string): boolean => {
  try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))); }
  catch { return false; }
};
export interface Config {
  webhook_host: string; webhook_port: number; admin_host: string; admin_port: number;
  admin_enabled: boolean; allow_non_loopback: boolean; admin_token: string;
  data_dir: string; static_dir: string; max_body_bytes: number; dedupe_window: number;
  repos: string[]; secrets: Record<string, string>; log_level: string;
  board_targets: Record<string, string>; board_repo: string; board_track_repo: string;
  board_source_dir: string; board_token: string; board_debounce: number; board_refresh: number; board_execution: 'local' | 'github_actions';
  github_app_id: string; github_app_private_key: string;
  gitcode_sync: GitCodeSyncConfig;
  require_signature?: boolean;
}
export function configFromEnv(env: Environment = {}, root = '.'): Config {
  const str = (key: string, fallback = '') => env[key] || fallback;
  const int = (key: string, fallback: number) => env[key] !== undefined && /^-?\d+$/.test(env[key]!) ? Number(env[key]) : fallback;
  const bool = (key: string, fallback: boolean) => env[key] === undefined ? fallback : !['0', 'false', 'no', 'off', ''].includes(env[key]!.trim().toLowerCase());
  const cfg: Config = {
    webhook_host: str('SDBOT_WEBHOOK_HOST', str('SDBOT_HOST', '127.0.0.1')),
    webhook_port: int('SDBOT_WEBHOOK_PORT', int('SDBOT_PORT', 8791)),
    admin_host: str('SDBOT_ADMIN_HOST', '127.0.0.1'), admin_port: int('SDBOT_ADMIN_PORT', 8792),
    admin_enabled: bool('SDBOT_ADMIN_ENABLED', true), allow_non_loopback: bool('SDBOT_ALLOW_NON_LOOPBACK', false),
    admin_token: str('SDBOT_ADMIN_TOKEN').trim(), data_dir: str('SDBOT_DATA_DIR', `${root}/.data`), static_dir: `${root}/static`,
    max_body_bytes: int('SDBOT_MAX_BODY_MB', 25) * 1024 * 1024, dedupe_window: int('SDBOT_DEDUPE_WINDOW', 2000),
    repos: str('SDBOT_REPOS').split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
    secrets: {}, log_level: str('SDBOT_LOG_LEVEL', 'INFO'),
    board_targets: JSON.parse(str('SDBOT_BOARD_TARGETS', '{}')),
    board_repo: str('SDBOT_BOARD_REPO').trim(), board_track_repo: str('SDBOT_BOARD_TRACK_REPO').trim(),
    board_source_dir: str('SDBOT_BOARD_SOURCE_DIR', `${root}/../github_status_board`),
    board_execution: str('SDBOT_BOARD_EXECUTION', 'local') as Config['board_execution'],
    board_token: str('SDBOT_BOARD_GITHUB_TOKEN').trim(), board_debounce: int('SDBOT_BOARD_DEBOUNCE', 20), board_refresh: int('SDBOT_BOARD_REFRESH', 3600),
    github_app_id: str('SDBOT_GITHUB_APP_ID').trim(), github_app_private_key: str('SDBOT_GITHUB_APP_PRIVATE_KEY').trim(),
    gitcode_sync: gitcodeSync(str, int, str('SDBOT_REPOS').split(',').map(v => v.trim()).filter(Boolean)),
  };
  if (!cfg.repos.length) cfg.repos = [...DEFAULT_REPOS];
  for (const provider of PROVIDERS) cfg.secrets[provider] = str(`SDBOT_${provider.toUpperCase()}_WEBHOOK_SECRET`, str('SDBOT_WEBHOOK_SECRET'));
  // With a token and a target, missing credentials only switch sync off, each with its own reason.
  const sync = cfg.gitcode_sync;
  if (sync.enabled) {
    if (!hasGitHubApp(cfg)) sync.disabled_reasons.push('no_github_app');
    if (!cfg.secrets.github) sync.disabled_reasons.push('no_webhook_secret');
    sync.enabled = !sync.disabled_reasons.length;
  }
  return cfg;
}
/** Both halves of the App credential; a lone ID (e.g. a var without its secret key) counts as missing. */
export const hasGitHubApp = (cfg: Config): boolean => !!cfg.github_app_id && !!cfg.github_app_private_key;
/**
 * Publishing needs App credentials (or, for local Node runs, the legacy token). Without them the board
 * is reported as disabled instead of failing startup; it does not need a webhook secret to collect.
 */
export function boardBlocked(cfg: Config, worker = false): '' | 'no_github_app' {
  if (!Object.keys(targets(cfg)).length || (hasGitHubApp(cfg) && !cfg.board_token)) return '';
  // Node's legacy local publisher may run on a static token instead of the App; Workers cannot.
  if (!worker && cfg.board_execution === 'local' && cfg.board_token && !cfg.github_app_id) return '';
  return 'no_github_app';
}
export const tracks = (cfg: Config, repo: string, provider = 'github'): boolean => !cfg.repos.length || (provider === 'github' && cfg.repos.some(r => r.toLowerCase() === repo.toLowerCase()));
export const targets = (cfg: Config): Record<string, string> => Object.keys(cfg.board_targets || {}).length ? cfg.board_targets : cfg.board_repo ? { [cfg.board_track_repo]: cfg.board_repo } : {};
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];
  if (!['local', 'github_actions'].includes(cfg.board_execution)) problems.push('board execution must be local or github_actions');
  const mapping = targets(cfg);
  const pairs = Object.entries(mapping);
  if (typeof cfg.board_targets !== 'object' || cfg.board_targets === null || Array.isArray(cfg.board_targets) ||
      pairs.some(pair => pair.some(repo => typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)))) {
    problems.push('board targets must map source owner/name to Pages owner/name');
  } else if (pairs.length) {
    const sources = pairs.map(([r]) => r.toLowerCase());
    const destinations = pairs.map(([, r]) => r.toLowerCase());
    if (new Set(sources).size !== sources.length || new Set(destinations).size !== destinations.length) problems.push('board sources and destinations must each be unique');
    if (sources.some(r => destinations.includes(r))) problems.push('board destinations must not be tracked sources');
    if (sources.some(r => !tracks(cfg, r))) problems.push('board sources must be included in SDBOT_REPOS');
    if (Object.keys(cfg.board_targets).length && cfg.board_repo) problems.push('use board targets or legacy board repository, not both');
    // Missing App credentials disable publishing (see boardBlocked); only contradictory settings are errors.
    if (cfg.github_app_id && cfg.board_token) problems.push('choose GitHub App credentials or board token, not both');
    if (cfg.board_debounce < 1 || cfg.board_refresh < 60) problems.push('board debounce must be >=1s and refresh >=60s');
  }
  const sync = cfg.gitcode_sync;
  if (sync?.enabled) {
    if (![sync.source, sync.target, sync.push_repo].every(r => REPO.test(r))) problems.push('GitCode sync requires owner/name for the GitHub source, GitCode target and push repository');
    else if (!tracks(cfg, sync.source)) problems.push('GitCode sync source must be included in SDBOT_REPOS');
    if (!sync.username) problems.push('GitCode sync requires a GitCode username for git push');
    if (!sync.branch_prefix || !BRANCH.test(sync.branch_prefix.replace(/\/$/, '')) || !sync.bases.length || sync.bases.some(b => !BRANCH.test(b) || (sync.branch_prefix + '1').startsWith(b + '/') || sync.branch_prefix.replace(/\/$/, '') === b))
      problems.push('GitCode sync branch prefix and base branches must be distinct, safe branch names');
    if (![sync.api_url, sync.web_url, sync.github_web_url].every(safeUrl)) problems.push('GitCode sync URLs must be HTTPS without credentials or query strings');
    if (!sync.ci_bot || !sync.check_name || sync.check_name.length > 100) problems.push('GitCode sync requires the CI bot login and a check name');
    if (sync.poll_seconds < 30 || sync.verdict_timeout_seconds < 600 || sync.max_attempts < 1 || sync.max_attempts > 10) problems.push('GitCode sync poll must be >=30s, verdict timeout >=600s and attempts 1-10');
  }
  if (cfg.max_body_bytes <= 0 || !Number.isSafeInteger(cfg.max_body_bytes)) problems.push('body limit must be positive');
  if (cfg.dedupe_window < 0 || !Number.isSafeInteger(cfg.dedupe_window)) problems.push('dedupe window must not be negative');
  for (const [label, host, port] of [['webhook', cfg.webhook_host, cfg.webhook_port], ['admin', cfg.admin_host, cfg.admin_port]] as const) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !cfg.allow_non_loopback) problems.push(`${label} listener requires loopback or SDBOT_ALLOW_NON_LOOPBACK=1`);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || [4310, 4311].includes(port)) problems.push(`${label} port is invalid or reserved`);
  }
  if (cfg.admin_enabled && cfg.admin_host === cfg.webhook_host && cfg.admin_port === cfg.webhook_port) problems.push('webhook and admin listeners must not share host:port');
  return problems;
}
export function publicConfig(cfg: Config): Doc {
  return { webhook: { host: cfg.webhook_host, port: cfg.webhook_port }, admin: { host: cfg.admin_host, port: cfg.admin_port, token_required: !!cfg.admin_token },
    data_dir: cfg.data_dir, repos: cfg.repos, store_payloads: true, payload_max_bytes: cfg.max_body_bytes,
    providers: Object.fromEntries(PROVIDERS.map(p => [p, { secret_configured: !!cfg.secrets[p], signature_required: !!cfg.require_signature }])),
    gitcode_sync: publicSyncConfig(cfg.gitcode_sync) };
}
/** `reason` joins every code so a consumer reading one field still sees all missing items. */
export function disabledSync(reasons: readonly SyncDisabledReason[]): Doc {
  const list = reasons.length ? [...reasons] : ['no_token'];
  return { enabled: false, reason: list.join(','), reasons: list };
}
/** Never includes the token or the account name used with it. */
export function publicSyncConfig(sync: GitCodeSyncConfig): Doc {
  if (!sync?.enabled) return disabledSync(sync?.disabled_reasons || []);
  return { enabled: true, source: sync.source, target: sync.target, push_repo: sync.push_repo, branch_prefix: sync.branch_prefix, bases: sync.bases,
    check_name: sync.check_name, token_configured: !!sync.token, poll_seconds: sync.poll_seconds, verdict_timeout_seconds: sync.verdict_timeout_seconds };
}
