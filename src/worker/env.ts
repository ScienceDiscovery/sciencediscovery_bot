/// <reference types="@cloudflare/workers-types" />
import { configFromEnv, targets, validateConfig, type Environment } from '../core/config.js';
import type { BotObject } from './index.js';

export interface WorkerEnv {
  BOT: DurableObjectNamespace<BotObject>;
  ARCHIVE: R2Bucket;
  [key: string]: unknown;
}
export const OBJECT_NAME = 'archive-v1';
export function workerConfig(env: WorkerEnv) {
  const cfg = configFromEnv(Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')) as Environment);
  cfg.require_signature = true;
  const errors = validateConfig(cfg);
  if (!Object.values(cfg.secrets).some(Boolean)) errors.push('a webhook secret is required');
  if (Object.keys(targets(cfg)).length && (!cfg.github_app_id || !cfg.github_app_private_key || cfg.board_token)) errors.push('Workers collection requires GitHub App credentials');
  if (errors.length) throw new TypeError('invalid Worker configuration');
  return cfg;
}
