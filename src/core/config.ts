import type { Doc } from './types.js';

export const DEFAULT_REPOS = ['openjiuwen-ai/sciencediscovery', 'sciencediscovery/sciencediscovery'];
export const PROVIDERS = ['github', 'gitcode'] as const;
export type Environment = Record<string, string | undefined>;
export interface Config {
  webhook_host: string; webhook_port: number; admin_host: string; admin_port: number;
  admin_enabled: boolean; allow_non_loopback: boolean; admin_token: string;
  data_dir: string; static_dir: string; max_body_bytes: number; dedupe_window: number;
  repos: string[]; secrets: Record<string, string>; log_level: string;
  board_targets: Record<string, string>; board_repo: string; board_track_repo: string;
  board_source_dir: string; board_token: string; board_debounce: number; board_refresh: number;
  github_app_id: string; github_app_private_key: string;
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
    board_token: str('SDBOT_BOARD_GITHUB_TOKEN').trim(), board_debounce: int('SDBOT_BOARD_DEBOUNCE', 20), board_refresh: int('SDBOT_BOARD_REFRESH', 3600),
    github_app_id: str('SDBOT_GITHUB_APP_ID').trim(), github_app_private_key: str('SDBOT_GITHUB_APP_PRIVATE_KEY').trim(),
  };
  if (!cfg.repos.length) cfg.repos = [...DEFAULT_REPOS];
  for (const provider of PROVIDERS) cfg.secrets[provider] = str(`SDBOT_${provider.toUpperCase()}_WEBHOOK_SECRET`, str('SDBOT_WEBHOOK_SECRET'));
  return cfg;
}
export const tracks = (cfg: Config, repo: string, provider = 'github'): boolean => !cfg.repos.length || (provider === 'github' && cfg.repos.some(r => r.toLowerCase() === repo.toLowerCase()));
export const targets = (cfg: Config): Record<string, string> => Object.keys(cfg.board_targets || {}).length ? cfg.board_targets : cfg.board_repo ? { [cfg.board_track_repo]: cfg.board_repo } : {};
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];
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
    if (!cfg.secrets.github || !(cfg.board_token || (cfg.github_app_id && cfg.github_app_private_key))) problems.push('board publishing requires GitHub App credentials (or a token) and GitHub webhook secret');
    if (!!cfg.github_app_id !== !!cfg.github_app_private_key) problems.push('GitHub App ID and private key must both be configured');
    if (cfg.github_app_id && cfg.board_token) problems.push('choose GitHub App credentials or board token, not both');
    if (cfg.board_debounce < 1 || cfg.board_refresh < 60) problems.push('board debounce must be >=1s and refresh >=60s');
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
    providers: Object.fromEntries(PROVIDERS.map(p => [p, { secret_configured: !!cfg.secrets[p] }])) };
}
