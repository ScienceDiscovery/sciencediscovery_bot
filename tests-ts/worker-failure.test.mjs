import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workerRuntime } from '../tools/worker-runtime.mjs';
import { switchingVersion } from '../src/worker/failure.ts';

test('an unhandled failure is logged with its cause and answered by whether a retry helps', { timeout: 60000 }, async t => {
  await mkdir('.tmp/tests-ts', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/tests-ts/worker-failure-'));
  const logs = [];
  const mf = await workerRuntime({ directory, entry: 'tests-ts/support/worker-rows.mjs', bindings: { SDBOT_GITHUB_WEBHOOK_SECRET: 'failure-secret' },
    handleRuntimeStdio: (stdout, stderr) => { for (const stream of [stdout, stderr]) stream.on('data', chunk => logs.push(String(chunk))); } });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });

  await t.test('calling an RPC method the object does not have reads as a version switch', async () => {
    const response = await mf.dispatchFetch('http://localhost/_test/missing-rpc');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { ok: false, error: 'the bot is switching to a new version; retry in a minute', retryable: true });
  });

  await t.test('anything else stays a plain 503, and the log carries the path and a scrubbed cause', async () => {
    const response = await mf.dispatchFetch('http://localhost/_test/broken?x=1');
    assert.deepEqual([response.status, response.headers.get('retry-after')], [503, null]);
    assert.deepEqual(await response.json(), { ok: false, error: 'service unavailable' });
    await new Promise(r => setTimeout(r, 200));
    const line = logs.join('').split('\n').find(l => l.includes('"path":"/_test/broken"'));
    assert.ok(line, 'the failure is logged');
    assert.match(line, /"error":"Error"/);
    assert.match(line, /secret=\[REDACTED\]/);
    assert.doesNotMatch(line, /hunter22/);
  });
});

test('version-switch messages are recognized and ordinary errors are not', () => {
  for (const message of ['The RPC receiver does not implement the method "actionsRules".', 'Durable Object reset because its code was updated.', 'Network connection lost.'])
    assert.equal(switchingVersion(message), true, message);
  for (const message of ['invalid grant time', 'SQLITE_ERROR: no such table', 'Unexpected token'])
    assert.equal(switchingVersion(message), false, message);
});
