export type {
  RoleDefinition,
  ModelConfig,
  RolePermissions,
  McpServerBinding,
  McpLoadMode,
  RoleValidationResult,
} from './types.js';
export {
  BUILTIN_ROLES,
  ROLE_ALIASES,
  orchestratorRole,
  researcherRole,
  implementerRole,
  auditorRole,
  devopsRole,
} from './builtin-roles.js';
export {
  RoleRegistry,
  RoleCycleError,
  RoleParentError,
  RoleValidationError,
} from './registry.js';
export {
  loadRolesFromYaml,
  loadRolesFromJson,
  loadRoleFiles,
  registerCustomRoles,
} from './loader.js';
export {
  clampedTurnCeiling,
  clampedDeadlineMs,
  clampedMaxTokens,
  clampedTurnTimeoutMs,
  filteredTools,
  isToolAllowed,
  toolDenialReason,
  toolDenialMessage,
  assertToolAllowed,
  RoleToolDeniedError,
  roleSystemPrompt,
  roleModelRoute,
  roleMaxTurns,
  roleDeadlineMs,
  raceAbort,
  type RoleModelRoute,
} from './filter.js';
export { applyRoleToLoopDeps, applyRoleToLoopContext, type RoleLoopSlice } from './bind.js';
export { mergeRole } from './merge.js';
export { validateRole, KNOWN_NATIVE_TOOLS } from './validate.js';
export { parseYaml } from './yaml-parser.js';
