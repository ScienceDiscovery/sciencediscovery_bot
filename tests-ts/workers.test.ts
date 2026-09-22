import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync, verify as rsaVerify } from 'node:crypto';
import { build } from 'esbuild';
import { delivery, secret } from './helpers.js';

test('portable core executes in Cloudflare workerd without nodejs_compat', async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests-ts/workerd-'));
  process.env.TMPDIR = root; process.env.XDG_CACHE_HOME = root; process.env.XDG_CONFIG_HOME = root;
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = resolve(root, 'worker.js');
  const result = await build({ entryPoints: ['tests-ts/support/worker.ts'], outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', metafile: true });
  assert.equal(Object.keys(result.metafile!.inputs).some(path => path.includes('/node/') || path.startsWith('node:')), false);
  const { Miniflare } = await import('miniflare');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mf = new Miniflare({ modules: true, scriptPath: output, compatibilityDate: '2026-07-30',
    bindings: { SDBOT_WEBHOOK_SECRET: secret, SDBOT_ADMIN_TOKEN: 'worker-test-admin', TEST_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() },
    host: '127.0.0.1', port: 0 });
  t.after(() => mf.dispose());
  const d = await delivery('issues', undefined, { delivery: 'worker-delivery' });
  const first = await mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', headers: Object.fromEntries(d.headers), body: d.body });
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true, delivery_id: 'worker-delivery' });
  await mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', headers: Object.fromEntries(d.headers), body: d.body });
  const events = await (await mf.dispatchFetch('http://localhost/_test/events')).json() as { events: { duplicate: boolean; hooks: string[] }[] };
  assert.equal(events.events.length, 2); assert.equal(events.events[0].duplicate, true); assert.deepEqual(events.events[1].hooks, ['analyze.on_issue', 'board.on_issue']);
  assert.equal((await mf.dispatchFetch('http://localhost/api/status')).status, 404);
  assert.equal((await mf.dispatchFetch('http://localhost/_test/admin/api/status', { headers: { authorization: 'Bearer worker-test-admin', 'Cf-Ray': 'local-test' } })).status, 403);
  assert.equal((await mf.dispatchFetch('http://localhost/webhook/github', { method: 'POST', headers: { 'x-github-event': 'ping' }, body: '{}' })).status, 401);
  const jwt = (await (await mf.dispatchFetch('http://localhost/_test/jwt')).json() as { jwt: string }).jwt;
  const [header, payload, signature] = jwt.split('.');
  assert.equal(rsaVerify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
});
