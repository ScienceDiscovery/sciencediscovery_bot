/// <reference types="@cloudflare/workers-types" />
import { configFromEnv, validateConfig, type Environment } from '../core/config.js';
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
  // Missing credentials degrade features (unsigned deliveries are rejected with 401, the board and GitCode
  // sync report why they are off); only contradictory or malformed settings stop the Worker.
  const errors = validateConfig(cfg);
  if (errors.length) throw new TypeError('invalid Worker configuration');
  return cfg;
}
