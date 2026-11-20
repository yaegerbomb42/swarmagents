/**
 * Pure helpers for the agent-role pipeline.
 *
 * These are trivial, but extracting them makes the UI component smaller and
 * gives the test runner a targets that doesn't require React or a DOM.
 */

import { uid, MAX_ROLES, type ActiveRole, type RolePreset } from "../data";

export function removeRole(roles: ActiveRole[], uid: string): ActiveRole[] {
  return roles.filter((r) => r.uid !== uid);
}

export function addRole(
  roles: ActiveRole[],
  preset: RolePreset,
  providerUid: string,
): { roles: ActiveRole[]; added: boolean } {
  if (roles.length >= MAX_ROLES) return { roles, added: false };
  const next = [...roles, { ...preset, uid: uid(), providerUid }];
  return { roles: next, added: true };
}

export function moveRole(roles: ActiveRole[], uid: string, toIndex: number): ActiveRole[] {
  const from = roles.findIndex((r) => r.uid === uid);
  if (from < 0) return roles;
  const n = [...roles];
  const [it] = n.splice(from, 1);
  const adjustedTo = toIndex > from ? toIndex - 1 : toIndex;
  n.splice(adjustedTo, 0, it);
  return n;
}

export function reorderRole(roles: ActiveRole[], fromIndex: number, toIndex: number): ActiveRole[] {
  if (fromIndex < 0 || fromIndex >= roles.length) return roles;
  if (toIndex < 0 || toIndex >= roles.length) return roles;
  if (fromIndex === toIndex) return roles;
  const n = [...roles];
  const [it] = n.splice(fromIndex, 1);
  n.splice(toIndex, 0, it);
  return n;
}
