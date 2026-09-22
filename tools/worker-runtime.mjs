import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

/** Shared local/test runtime. Outbound access is denied unless explicitly supplied. */
export async function workerRuntime({ directory, bindings, outboundService, port = 0, entry = 'src/worker/index.ts' }) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  process.env.TMPDIR = directory;
  process.env.XDG_CACHE_HOME = directory;
  process.env.XDG_CONFIG_HOME = directory;
  const { Miniflare } = await import('miniflare');
  await build({ entryPoints: { index: entry, 'local-admin': 'src/worker/local-admin.ts' }, outdir: directory, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.html': 'text' }, external: ['cloudflare:workers'] });
  const common = { compatibilityDate: '2026-07-30', modules: true,
    outboundService: outboundService || (() => new Response(null, { status: 503 })) };
  const namespace = { className: 'BotObject', scriptName: 'bot', useSQLite: true };
  const mf = new Miniflare({ host: '127.0.0.1', port, durableObjectsPersist: resolve(directory, 'state/do'), r2Persist: resolve(directory, 'state/r2'),
    workers: [
      { ...common, name: 'bot', scriptPath: resolve(directory, 'index.js'), bindings, durableObjects: { BOT: namespace }, r2Buckets: { ARCHIVE: 'archive' } },
      { ...common, name: 'admin', scriptPath: resolve(directory, 'local-admin.js'), durableObjects: { BOT: namespace }, bindings: { PANEL: await readFile('static/index.html', 'utf8') } },
    ],
  });
  try { await mf.ready; } catch (error) { await mf.dispose(); throw error; }
  return mf;
}
