import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitTransferError, basicAuthorization, pushCommit, receiveRefs } from '../src/core/git-http.js';
import { GIT_FIXTURE, gitWorld } from './support/git-world.js';

test('pushCommit copies a GitHub head into GitCode with the same SHA across diverged histories', { timeout: 60000 }, async t => {
  const w = await gitWorld(t);
  const result = await pushCommit({ source: w.source, target: w.target, sha: w.ids.head, ref: 'refs/heads/github-pr/1', haves: [w.ids.gitcodeOnly, w.ids.common] });
  assert.deepEqual(result, { status: 'pushed', old: '0'.repeat(40), new: w.ids.head, ref: 'refs/heads/github-pr/1' });
  assert.equal(w.git(w.gitcode, 'rev-parse', 'refs/heads/github-pr/1'), w.ids.head, 'the exact GitHub SHA, not a rebased copy');
  assert.equal(w.git(w.gitcode, 'cat-file', '-t', w.ids.githubOnly), 'commit', 'GitHub-only ancestors travel with the head');
  w.git(w.gitcode, 'fsck', '--connectivity-only', '--no-dangling');
  assert.equal(w.git(w.gitcode, 'rev-parse', 'refs/heads/main'), w.ids.gitcodeOnly, 'the default branch is untouched');
  assert.ok(w.requests.filter(r => r.host === 'github' && r.method === 'POST').every(r => r.protocol === 'version=2'));
  // Repeat delivery: nothing to transfer, no upload-pack request.
  const before = w.requests.length;
  assert.equal((await pushCommit({ source: w.source, target: w.target, sha: w.ids.head, ref: 'refs/heads/github-pr/1' })).status, 'unchanged');
  assert.equal(w.requests.length, before + 1, 'only the receive-pack advertisement is read');
  // New commits and a force-push (non fast-forward) both keep GitHub's SHAs.
  const next = await w.commit('pull-request-2'); w.git(w.work, 'push', '-q', '-f', w.github, 'HEAD:refs/pull/1/head');
  assert.equal((await pushCommit({ source: w.source, target: w.target, sha: next, ref: 'refs/heads/github-pr/1' })).old, w.ids.head);
  assert.equal(w.git(w.gitcode, 'rev-parse', 'refs/heads/github-pr/1'), next);
  w.git(w.work, 'checkout', '-q', '-b', 'rewritten', w.ids.githubOnly);
  const rewritten = await w.commit('pull-request-rewritten'); w.git(w.work, 'push', '-q', '-f', w.github, 'HEAD:refs/pull/1/head');
  await pushCommit({ source: w.source, target: w.target, sha: rewritten, ref: 'refs/heads/github-pr/1' });
  assert.equal(w.git(w.gitcode, 'rev-parse', 'refs/heads/github-pr/1'), rewritten);
  const refs = await receiveRefs(w.target);
  assert.equal(refs.refs.get('refs/heads/github-pr/1'), rewritten); assert.ok(refs.capabilities.has('report-status'));
});

test('pushCommit failures are typed and never expose credentials or change refs', { timeout: 60000 }, async t => {
  const w = await gitWorld(t);
  const wrongTarget = { ...w.target, authorization: basicAuthorization(GIT_FIXTURE.gitcodeUser, 'wrong-' + GIT_FIXTURE.gitcodeToken) };
  await assert.rejects(pushCommit({ source: w.source, target: wrongTarget, sha: w.ids.head, ref: 'refs/heads/github-pr/1' }), (error: unknown) => {
    assert.ok(error instanceof GitTransferError); assert.equal(error.code, 'permission_denied'); assert.equal(error.transient, false);
    assert.ok(!error.message.includes(GIT_FIXTURE.gitcodeToken) && !error.message.includes(GIT_FIXTURE.gitcodeUser)); return true;
  });
  const wrongSource = { ...w.source, authorization: basicAuthorization('x-access-token', 'expired') };
  await assert.rejects(pushCommit({ source: wrongSource, target: w.target, sha: w.ids.head, ref: 'refs/heads/github-pr/1' }), (error: unknown) =>
    error instanceof GitTransferError && error.code === 'permission_denied' && !error.message.includes(GIT_FIXTURE.githubToken));
  await assert.rejects(pushCommit({ source: w.source, target: w.target, sha: 'f'.repeat(40), ref: 'refs/heads/github-pr/1' }), (error: unknown) =>
    error instanceof GitTransferError && ['object_unavailable', 'protocol_error'].includes(error.code));
  for (const ref of ['refs/heads/../main', 'refs/tags/v1', 'refs/heads/x.lock']) await assert.rejects(pushCommit({ source: w.source, target: w.target, sha: w.ids.head, ref }), /unsafe branch name/);
  assert.throws(() => w.git(w.gitcode, 'rev-parse', '--verify', '-q', 'refs/heads/github-pr/1'));
});
