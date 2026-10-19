import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerCeiling, intersectPermissions } from '../src/core/installations.js';

test('installation ceilings use the lowest approved level, with no workflows read level', () => {
  assert.deepEqual(intersectPermissions({ metadata: 'write', issues: 'write', pull_requests: 'write', merge_queues: 'read', workflows: 'write' },
    { issues: 'read', pull_requests: 'read', workflows: 'read' }), { metadata: 'read', issues: 'read', pull_requests: 'read' });
  assert.deepEqual(intersectPermissions({ contents: 'write', issues: 'read' }, { contents: 'read' }), { metadata: 'read', contents: 'read' });
  assert.deepEqual(intersectPermissions(), { metadata: 'read' });
  assert.deepEqual(intersectPermissions({ workflows: 'write' }, { workflows: 'write' }), { metadata: 'read', workflows: 'write' });
});

test('only usable selected repositories contribute; an empty selection means all tracked repositories', () => {
  const installation = (id: number, repositories: string[], issues: string, suspended = false) => ({ id, repositories, permissions: { issues }, suspended,
    account: 'fixture', target_type: 'Organization', repository_selection: 'selected', total_repositories: repositories.length, truncated: false });
  const inventory = { tracked_repositories: ['org/one', 'org/two'], eligible_repositories: ['org/one', 'org/two'], installations: [
    installation(1, ['org/one'], 'write'), installation(2, ['org/two'], 'read'), installation(3, ['other/repo'], 'none'), installation(4, ['org/one'], 'none', true),
  ] };
  assert.deepEqual(callerCeiling(inventory, []), { metadata: 'read', issues: 'read' });
  assert.deepEqual(callerCeiling(inventory, ['ORG/ONE']), { metadata: 'read', issues: 'write' });
  assert.deepEqual(callerCeiling(inventory, ['missing/repo']), { metadata: 'read' });
});
