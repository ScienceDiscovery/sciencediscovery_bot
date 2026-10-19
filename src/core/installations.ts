import { PERMISSION_CATALOG, type PermissionSet } from './permissions.js';

export interface AppInstallation {
  id: number; account: string; target_type: string; repository_selection: string; suspended: boolean;
  permissions: Record<string, string>;
}
export interface InstallationInventory extends AppInstallation {
  repositories: string[]; total_repositories: number | null; truncated: boolean;
}
export interface CallerInventory {
  installations: InstallationInventory[]; eligible_repositories: string[]; tracked_repositories: string[];
}

/** Missing permissions are none. Workflows has no read level; metadata is always read. */
export function intersectPermissions(...sets: Readonly<Record<string, unknown>>[]): PermissionSet {
  const result: PermissionSet = { metadata: 'read' };
  for (const item of PERMISSION_CATALOG) {
    if (item.required) continue;
    const rank = Math.min(...sets.map(set => item.levels.includes(set[item.key] as 'read' | 'write')
      ? set[item.key] === 'write' ? 2 : 1 : 0), sets.length ? 2 : 0);
    if (rank) result[item.key] = rank === 2 ? 'write' : 'read';
  }
  return result;
}

export function callerCeiling(inventory: CallerInventory, selected: string[]): PermissionSet {
  const wanted = new Set((selected.length ? selected : inventory.tracked_repositories).map(repo => repo.toLowerCase()));
  return intersectPermissions(...inventory.installations.filter(installation => !installation.suspended
    && installation.repositories.some(repo => wanted.has(repo.toLowerCase()))).map(installation => installation.permissions));
}
