import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const directory = resolve('.tmp/workers-check');
await mkdir(directory, { recursive: true });
// Isolate Wrangler state and disable credential discovery/telemetry. Dry run
// bundles and validates bindings but creates no remote resources.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'LC_ALL'].includes(key)));
Object.assign(env, { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, TMPDIR: directory,
  WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' });
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', resolve(directory, 'bundle')], { env, stdio: 'inherit' });
child.once('exit', code => { process.exitCode = code ?? 1; });
