import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configFromEnv, type Config } from '../src/core/config.js';
import { FileArchive } from '../src/node/archive.js';
import { BotApplication } from '../src/core/http.js';
import { Pipeline } from '../src/core/pipeline.js';
import { Router } from '../src/core/bus.js';
import { sign } from '../src/core/signature.js';
import { jsonBytes, type Doc } from '../src/core/types.js';
export const secret = 'isolated-webhook-test-secret';
export const fixture = async (name = 'github/issue_opened.json'): Promise<Doc> => JSON.parse(await readFile(resolve('fixtures', name), 'utf8')) as Doc;
export async function harness(overrides: Partial<Config> = {}) {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/case-'));
  const cfg = { ...configFromEnv({}, resolve('.')), secrets: { github: secret, gitcode: secret }, data_dir: directory, ...overrides };
  const store = await FileArchive.open(directory, cfg.dedupe_window), router = new Router(), pipeline = new Pipeline(cfg, store, router);
  const app = new BotApplication(pipeline, () => readFile('static/index.html', 'utf8'));
  return { cfg, store, router, pipeline, app, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
export async function delivery(event = 'issues', payload: Doc = { action: 'opened', repository: { full_name: 'ScienceDiscovery/sciencediscovery' }, issue: { number: 1, title: 'test' } }, options: { provider?: string; delivery?: string; path?: string; secret?: string; form?: boolean } = {}) {
  const provider = options.provider || 'github';
  const body = options.form ? new TextEncoder().encode(new URLSearchParams({ payload: JSON.stringify(payload) }).toString()) : jsonBytes(payload);
  const headers = new Headers({ 'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json', [`x-${provider}-event`]: event, [`x-${provider}-delivery`]: options.delivery || crypto.randomUUID() });
  headers.set(provider === 'github' ? 'x-hub-signature-256' : 'x-gitcode-signature-256', await sign(body, options.secret ?? secret));
  return { headers, body, request: () => new Request('http://localhost' + (options.path || '/webhook'), { method: 'POST', headers, body }) };
}
