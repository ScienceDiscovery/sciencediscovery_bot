import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { FileArchive } from '../src/node/archive.js';
import { listener } from '../src/node/server.js';
import { sign } from '../src/core/signature.js';
import { object, string, utf8 } from '../src/core/types.js';
import { delivery, harness, secret } from './helpers.js';

test('every attempt stores exact request/response; headers and query values are redacted', async t => {
  const h = await harness(); t.after(h.cleanup);
  const d = await delivery('issues', undefined, { path: '/wrong?token=sensitive&x=private' });
  d.headers.set('authorization', 'Bearer sensitive'); d.headers.set('cookie', 'secret=value');
  const response = await h.app.webhook(d.request()), wire = await response.text();
  assert.equal(response.status, 404);
  const record = (await h.store.recent(1))[0], detail = (await h.store.detail(string(record.record_id)))!;
  const request = object(detail.request), stored = object(detail.response);
  assert.equal(request.body, new TextDecoder().decode(d.body)); assert.equal(stored.body, wire); assert.equal(stored.status, 404);
  for (const name of ['date', 'content-type', 'content-length', 'cache-control', 'server']) assert.equal(object(stored.headers)[name], response.headers.get(name));
  assert.equal(object(request.headers).authorization, '[REDACTED]'); assert.equal(object(request.headers).cookie, '[REDACTED]');
  assert.equal(String(request.path).includes('sensitive'), false); assert.equal(String(request.path).includes('private'), false);
});
test('reboot restores lifetime counts and dedupe; legacy records remain readable', async t => {
  const h = await harness({ dedupe_window: 2 }); t.after(h.cleanup);
  const d = await delivery('ping', { zen: 'hello' }, { delivery: 'first' });
  await h.pipeline.receive(d.headers, d.body); await h.pipeline.receive(d.headers, d.body);
  const restored = await FileArchive.open(h.directory, 2); assert.equal(restored.seen('github', 'first'), true);
  assert.deepEqual(object(restored.status().counts), object(h.store.status().counts));
  const legacyDir = join(h.directory, 'legacy');
  const old = await FileArchive.open(legacyDir);
  await writeFile(old.eventsPath, '{"delivery_id":"historical","status":"accepted","provider":"github","payload_file":"body.json"}\nmalformed\n');
  await writeFile(join(legacyDir, 'body.json'), '{"legacy":true}');
  const loaded = await FileArchive.open(legacyDir), detail = (await loaded.detail('historical'))!;
  assert.equal(detail.legacy, true); assert.equal(detail.response, null); assert.equal(object(detail.request).body, '{"legacy":true}');
  assert.match(string(object(detail.record).record_id), /^legacy-/);
});
test('historical queries scan past multi-megabyte tails and exact record ID takes priority', async t => {
  const h = await harness(); t.after(h.cleanup);
  const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ record_id: `id-${i}`, delivery_id: i === 299 ? 'id-0' : `delivery-${i}`, status: 'accepted', route: i === 0 ? 'old' : 'recent', title: 'x'.repeat(17000) }));
  await writeFile(h.store.eventsPath, lines.join('\n') + '\n');
  assert.equal((await h.store.recent(1, 0, { route: 'old' }))[0].record_id, 'id-0');
  assert.equal((await h.store.find('id-0'))?.delivery_id, 'delivery-0');
  assert.equal((await h.store.recent(1, 299))[0].record_id, 'id-0');
});
test('payload reads reject traversal and symlink escape', async t => {
  const h = await harness(); t.after(h.cleanup);
  await symlink(resolve('README.md'), join(h.directory, 'escape'));
  assert.equal(await h.store.payload({ payload_file: 'escape' }), null);
  assert.equal(await h.store.payload({ payload_file: '../../README.md' }), null);
});
test('binary rejection retains base64; oversized prefix cannot be replayed', async t => {
  const h = await harness({ max_body_bytes: 16 }); t.after(h.cleanup);
  const response = await h.app.webhook(new Request('http://localhost/webhook/github', { method: 'POST', headers: { 'x-github-event': 'ping' }, body: new Uint8Array([255, 254]) }));
  assert.equal(response.status, 401);
  let record = (await h.store.recent(1))[0], detail = (await h.store.detail(string(record.record_id)))!;
  assert.equal(object(detail.request).body_encoding, 'base64'); assert.equal(object(detail.request).body, '//4=');
  const d = await delivery('ping', { zen: 'x'.repeat(50) });
  assert.equal((await h.app.webhook(d.request())).status, 413);
  record = (await h.store.recent(1))[0]; assert.equal(record.payload_bytes, 16); assert.equal(record.body_complete, false);
  const replay = await h.app.admin(new Request('http://localhost/api/replay/' + record.record_id, { method: 'POST', headers: { 'x-requested-with': 'sciencediscovery-bot' } }));
  assert.equal(replay.status, 409);
});
test('storage failures never acknowledge delivery and do not poison dedupe', async t => {
  const h = await harness(); t.after(h.cleanup); const original = h.store.save.bind(h.store), d = await delivery();
  h.store.save = async () => { throw new Error('secret/path'); };
  const response = await h.app.webhook(d.request()); assert.equal(response.status, 503); assert.equal(await response.text(), '{"ok":false,"error":"storage unavailable"}');
  assert.equal(h.store.seen('github', d.headers.get('x-github-delivery')!), false);
  h.store.save = original; assert.equal((await h.app.webhook(d.request())).status, 200);
});
test('unexpected business errors are isolated and signatures checked before body parsing', async t => {
  const h = await harness(); t.after(h.cleanup);
  const body = utf8.encode('{broken');
  const result = await h.pipeline.receive(new Headers({ 'x-github-event': 'ping', 'x-hub-signature-256': 'bad' }), body);
  assert.equal(result.status, 401);
  h.router.dispatch = async () => { throw new Error('secret'); };
  const d = await delivery(); const response = await h.app.webhook(d.request()); assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await h.store.recent(1)).includes('secret'), false);
});
test('form payloads replay exact original attempt with fresh signature/delivery', async t => {
  const h = await harness(); t.after(h.cleanup);
  const d = await delivery('issues', undefined, { form: true });
  await h.app.webhook(d.request()); const original = (await h.store.recent(1))[0];
  const response = await h.app.admin(new Request('http://localhost/api/replay/' + original.record_id, { method: 'POST', headers: { 'x-requested-with': 'sciencediscovery-bot', origin: 'http://localhost' } }));
  assert.equal(response.status, 200);
  const replayed = object(object(await response.json()).record);
  assert.notEqual(replayed.delivery_id, original.delivery_id); assert.equal(object(replayed.extra).replayed_from, original.record_id);
  assert.deepEqual(new Uint8Array((await h.store.payload(replayed))!), d.body); assert.equal(replayed.route, 'issue.opened');
});
test('management guard, exact public routes, pagination and listener inventory', async t => {
  const h = await harness({ admin_token: 'local-token' }); t.after(h.cleanup);
  for (const path of ['/', '/api/status', '/api/events', '/api/listeners']) assert.equal((await h.app.webhook(new Request('http://localhost' + path))).status, 404);
  assert.deepEqual(await (await h.app.webhook(new Request('http://localhost/healthz'))).json(), { ok: true });
  assert.equal((await h.app.admin(new Request('http://localhost/'))).status, 200);
  for (const path of ['/', '/healthz', '/api/status', '/api/events', '/api/listeners']) {
    assert.equal((await h.app.admin(new Request('http://localhost' + path, { headers: { 'CF-Fake': '1', authorization: 'Bearer local-token' } }))).status, 403);
    if (path !== '/') assert.equal((await h.app.admin(new Request('http://localhost' + path))).status, 401);
  }
  const headers = { authorization: 'Bearer local-token' };
  const inventory = await (await h.app.admin(new Request('http://localhost/api/listeners', { headers }))).json() as { listeners: unknown[] }; assert.equal(inventory.listeners.length, 11);
  for (let i = 0; i < 3; i++) { const d = await delivery(); await h.app.webhook(d.request()); }
  const page = object(await (await h.app.admin(new Request('http://localhost/api/events?limit=2', { headers }))).json()); assert.equal(page.count, 2); assert.equal(page.has_more, true);
  assert.equal((await h.app.admin(new Request('http://localhost/api/events?limit=wrong', { headers }))).status, 400);
  assert.equal((await h.app.admin(new Request('http://localhost/api/replay/missing', { method: 'POST', headers }))).status, 403);
  assert.equal((await h.app.admin(new Request('http://localhost/api/replay/missing', { method: 'POST', headers: { ...headers, 'x-requested-with': 'sciencediscovery-bot', origin: 'http://evil.example' } }))).status, 403);
});
test('real Node HTTP listeners archive wire replies and parser rejection', async t => {
  const h = await harness(); t.after(h.cleanup);
  const server = listener(h.app, false); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const port = (server.address() as AddressInfo).port, base = `http://127.0.0.1:${port}`;
  const d = await delivery('ping', { zen: 'hello' }), response = await fetch(base + '/webhook/github', { method: 'POST', headers: d.headers, body: d.body });
  const wire = await response.text(); assert.equal(response.status, 200);
  const detail = (await h.store.detail(string((await h.store.recent(1))[0].record_id)))!;
  assert.equal(object(detail.response).body, wire); assert.equal(object(object(detail.response).headers).date, response.headers.get('date'));
  const raw = await new Promise<string>((done, reject) => {
    const socket = connect(port, '127.0.0.1'); let reply = '';
    socket.on('connect', () => socket.write('POST /webhook/github HTTP/1.1\r\nHost: localhost\r\nX-GitHub-Event: ping\r\nContent-Length: nope\r\n\r\n'));
    socket.on('data', chunk => { reply += chunk; }); socket.on('end', () => done(reply)); socket.on('error', reject); socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
  });
  assert.match(raw, /400 Bad Request/); const bad = (await h.store.recent(1))[0]; assert.equal(bad.http_status, 400); assert.equal(bad.body_complete, false);
  const partial = await new Promise<string>((done, reject) => {
    const socket = connect(port, '127.0.0.1'); let reply = '';
    socket.on('connect', () => socket.end('POST /webhook/github HTTP/1.1\r\nHost: localhost\r\nX-GitHub-Event: ping\r\nContent-Length: 100\r\n\r\n{"zen":'));
    socket.on('data', chunk => { reply += chunk; }); socket.on('end', () => done(reply)); socket.on('error', reject); socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
  });
  assert.match(partial, /400 Bad Request/);
  const interrupted = (await h.store.recent(1))[0]; assert.equal(interrupted.payload_bytes, 7); assert.equal(interrupted.body_complete, false);
  assert.equal(new TextDecoder().decode((await h.store.payload(interrupted))!), '{"zen":');
});
test('finite dedupe window and zero window retain their configured behavior', async t => {
  const h = await harness({ dedupe_window: 1 }); t.after(h.cleanup);
  for (const id of ['a', 'b', 'a']) { const d = await delivery('ping', {}, { delivery: id }); assert.equal((await h.pipeline.receive(d.headers, d.body)).record.duplicate, false); }
  assert.equal(object(h.store.status().counts).accepted, 3); assert.equal(h.store.status().remembered_deliveries, 1);
  const zero = await FileArchive.open(h.directory, 0); assert.equal(zero.seen('github', 'a'), false);
});
