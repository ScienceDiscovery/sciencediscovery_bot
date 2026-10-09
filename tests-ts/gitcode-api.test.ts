import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitCodeApi, mergeRequestNumber } from '../src/core/gitcode-api.js';

const REPO = 'openJiuwen/sciencediscovery';
/** GitCode REST answered from a route table; unknown routes are 404. No request leaves the process. */
function api(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const client = new GitCodeApi({ api_url: 'https://gitcode.test/api/v5', web_url: 'https://gitcode.test', token: 'gitcode-fake-token', auth_mode: 'header' }, (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), key = `${(init.method || 'GET').toUpperCase()} ${url.pathname.replace('/api/v5', '')}`;
    calls.push(key);
    return key in routes ? Response.json(routes[key]) : Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof fetch);
  return { client, calls };
}
const mr = (extra: Record<string, unknown>) => ({ title: 'mirror', state: 'opened', head: { ref: 'github-pr/120', sha: 'a'.repeat(40) }, base: { ref: 'main' }, ...extra });

test('merge request numbers come from number or iid, as integers or integer strings, never from id', async () => {
  for (const [doc, expected] of [
    [{ number: 11 }, 11], [{ number: '11' }, 11], [{ iid: '11' }, 11], [{ iid: 11 }, 11], [{ number: ' 175 ' }, 175], [{ number: '', iid: '12' }, 12],
    [{ number: 1.5 }, null], [{ number: '1.5' }, null], [{ number: 'abc' }, null], [{ number: '' }, null], [{ number: 0 }, null], [{ number: -3 }, null],
    [{ id: 999 }, null], [{}, null], [null, null],
  ] as const) assert.equal(mergeRequestNumber(doc), expected, JSON.stringify(doc));
  const { client } = api({ [`GET /repos/${REPO}/pulls/11`]: mr({ number: '11' }), [`GET /repos/${REPO}/pulls/12`]: mr({ iid: '12', id: 9001 }) });
  assert.equal((await client.getPull(REPO, 11)).number, 11);
  assert.equal((await client.getPull(REPO, 12)).number, 12, 'iid, not the global id');
});

test('one merge request without a number does not hide the matching one next to it', async () => {
  const { client } = api({ [`GET /repos/${REPO}/pulls`]: [mr({ id: 9001 }), mr({ number: 11, state: 'open' }), 'junk'] });
  const found = await client.findPull(REPO, 'github-pr/120', REPO);
  assert.equal(found?.number, 11);
});

test('a created merge request must name its number; nothing is made up', async () => {
  for (const body of [{}, { id: 9001, title: 'mirror' }]) {
    const { client } = api({ [`POST /repos/${REPO}/pulls`]: body });
    await assert.rejects(client.createPull(REPO, { title: 't', head: 'github-pr/120', base: 'main', body: 'b' }), /merge request without a number/);
  }
});

test('an update whose response omits the number is read back by the number it updated', async () => {
  for (const body of [{}, { state: 'closed' }]) {
    const { client, calls } = api({ [`PATCH /repos/${REPO}/pulls/11`]: body, [`GET /repos/${REPO}/pulls/11`]: mr({ number: 11, state: 'closed' }) });
    const pull = await client.updatePull(REPO, 11, { state: 'closed' });
    assert.equal(pull.number, 11); assert.equal(pull.state, 'closed');
    assert.deepEqual(calls, [`PATCH /repos/${REPO}/pulls/11`, `GET /repos/${REPO}/pulls/11`]);
  }
  // A response with the number is used as is.
  const direct = api({ [`PATCH /repos/${REPO}/pulls/11`]: mr({ iid: '11', state: 'closed' }) });
  assert.equal((await direct.client.updatePull(REPO, 11, { state: 'closed' })).number, 11); assert.equal(direct.calls.length, 1);
  // If the read-back fails too, the original error stands.
  const lost = api({ [`PATCH /repos/${REPO}/pulls/11`]: {} });
  await assert.rejects(lost.client.updatePull(REPO, 11, { state: 'closed' }), /merge request without a number/);
});
