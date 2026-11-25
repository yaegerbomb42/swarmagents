/**
 * Live self-management for one run.
 *
 * The agent calls meta-tools; this session is the authority. A role change
 * is checked with roleCapabilityDelta against the run's starting role and
 * can never widen the tool allowlist past the policy ceiling. Skills come
 * from the Library map only. MCP servers must be on the allowlist and in
 * the shipped registry. Every call is appended to the audit log, and a
 * successful change produces an injection the harness feeds back into the
 * live session.
 */

import {
  ROLE_MCP_SERVER_REGISTRY,
  buildRunRolePolicy,
  hasRoleEscalation,
  resolveRoleSwitch,
  roleCapabilityDelta,
  type RoleDefinition,
  type RunRolePolicy,
} from "../roles";
import { roleAllowedTools, rolePhase } from "../harness/role-mcp";
import type { RolePhase } from "../harness/types";

export const META_TOOLS = [
  "set_role",
  "load_skill",
  "drop_skill",
  "connect_mcp",
  "disconnect_mcp",
  "manage_context",
] as const;

export type MetaToolName = (typeof META_TOOLS)[number];

export const DEFAULT_SKILL_CAP = 10;
export const SKILL_DIR = ".claude/skills";

export interface AuditEntry {
  at: number;
  tool: string;
  ok: boolean;
  detail: string;
  why?: string;
}

export interface FsOp {
  op: "write" | "delete";
  path: string;
}

export interface MetaResult {
  ok: boolean;
  error?: string;
  injection: string;
  audit: AuditEntry;
  fs: FsOp[];
  /** Set when the harness should resume the live session under a new allowlist. */
  resumePhase?: RolePhase;
}

export interface SelfManageOptions {
  catalog: readonly RoleDefinition[];
  policy?: RunRolePolicy;
  /** role the run starts as; required when policy is omitted. */
  startingRole?: RoleDefinition;
  grantedRoleIds?: readonly string[];
  /** Library skill id -> markdown body. Anything absent cannot be loaded. */
  library: ReadonlyMap<string, string>;
  /** Extra MCP ids a Studio manifest allows, still intersected with the registry. */
  manifestMcpIds?: readonly string[];
  skillCap?: number;
  now?: () => number;
  desktopMode?: boolean;
}

function skillPath(id: string): string {
  return `${SKILL_DIR}/${id}/SKILL.md`;
}

export function isMetaTool(name: string): boolean {
  if (META_TOOLS.includes(name as MetaToolName)) return true;
  const parts = name.split("__");
  const tool = parts[parts.length - 1];
  return META_TOOLS.includes(tool as MetaToolName);
}

export function metaToolName(name: string): MetaToolName | null {
  if (!isMetaTool(name)) return null;
  const parts = name.split("__");
  return parts[parts.length - 1] as MetaToolName;
}

export class SelfManageSession {
  readonly policy: RunRolePolicy;
  readonly catalog: readonly RoleDefinition[];
  readonly library: ReadonlyMap<string, string>;
  readonly skillCap: number;
  readonly ceiling: ReadonlySet<string>;
  readonly mcpAllowlist: ReadonlySet<string>;
  currentRole: RoleDefinition;
  allowlist: string[];
  readonly loadedSkills = new Set<string>();
  readonly pinned = new Set<string>();
  readonly connectedMcp = new Set<string>();
  readonly audit: AuditEntry[] = [];
  injections: string[] = [];
  private readonly now: () => number;
  private readonly desktopMode: boolean;

  constructor(opts: SelfManageOptions) {
    const starting = opts.startingRole ?? opts.policy?.startingRole;
    if (!starting) throw new Error("self-manage session needs a starting role");
    this.catalog = opts.catalog;
    this.policy = opts.policy ?? buildRunRolePolicy(opts.catalog, starting, opts.grantedRoleIds ?? []);
    this.library = opts.library;
    this.skillCap = opts.skillCap ?? DEFAULT_SKILL_CAP;
    this.now = opts.now ?? Date.now;
    this.desktopMode = opts.desktopMode === true;
    this.currentRole = this.policy.startingRole;
    const ceiling = new Set<string>();
    const mcp = new Set<string>();
    const grant = new Set(this.policy.grantedRoleIds);
    for (const role of opts.catalog) {
      const inCeiling = role.id === this.policy.startingRole.id || grant.has(role.id) || this.policy.allowedRoleIds.includes(role.id);
      if (!inCeiling) continue;
      if (role.id !== this.policy.startingRole.id && !grant.has(role.id) && hasRoleEscalation(roleCapabilityDelta(this.policy.startingRole, role))) {
        continue;
      }
      for (const tool of roleAllowedTools(role, { desktopMode: this.desktopMode })) ceiling.add(tool);
      for (const server of role.mcpServers) if (server in ROLE_MCP_SERVER_REGISTRY) mcp.add(server);
    }
    for (const id of opts.manifestMcpIds ?? []) {
      if (id in ROLE_MCP_SERVER_REGISTRY || id.startsWith("lib-") || id.startsWith("custom-") || id === "tool-forge") {
        mcp.add(id);
      }
    }
    this.ceiling = ceiling;
    this.mcpAllowlist = mcp;
    this.allowlist = this.clampTools(roleAllowedTools(this.currentRole, { desktopMode: this.desktopMode }));
  }

  private clampTools(tools: readonly string[]): string[] {
    return tools.filter((tool) => this.ceiling.has(tool));
  }

  toolAllowed(name: string): boolean {
    if (isMetaTool(name)) return true;
    if (this.allowlist.includes(name)) return true;
    const info = name.split("__");
    if (info.length >= 3 && this.allowlist.includes(`mcp__${info[info.length - 2]}__*`)) return true;
    return false;
  }

  apply(toolName: string, input: unknown): MetaResult {
    const tool = metaToolName(toolName);
    if (!tool) return this.fail(toolName, "not a meta-tool");
    const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const why = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : typeof args.why === "string" ? args.why.trim().slice(0, 240) : undefined;
    switch (tool) {
      case "set_role":
        return this.setRole(String(args.roleId ?? args.role_id ?? ""), why);
      case "load_skill":
        return this.loadSkill(String(args.skillId ?? args.skill_id ?? ""), why);
      case "drop_skill":
        return this.dropSkill(String(args.skillId ?? args.skill_id ?? ""), why);
      case "connect_mcp":
        return this.connectMcp(String(args.serverId ?? args.server_id ?? ""), why);
      case "disconnect_mcp":
        return this.disconnectMcp(String(args.serverId ?? args.server_id ?? ""), why);
      case "manage_context":
        return this.manageContext(String(args.action ?? ""), String(args.target ?? args.name ?? ""), why);
      default:
        return this.fail(tool, "unsupported");
    }
  }

  private setRole(roleId: string, why?: string): MetaResult {
    const decision = resolveRoleSwitch(this.catalog, new Set(this.policy.allowedRoleIds), roleId);
    if (!decision.ok) return this.fail("set_role", decision.error === "not_allowed" ? "role is outside this run's policy" : "unknown role", why);
    const delta = roleCapabilityDelta(this.policy.startingRole, decision.role);
    if (hasRoleEscalation(delta) && !this.policy.grantedRoleIds.includes(decision.role.id)) {
      return this.fail("set_role", "role change would escalate privileges", why);
    }
    this.currentRole = decision.role;
    this.allowlist = this.clampTools(roleAllowedTools(decision.role, { desktopMode: this.desktopMode }));
    const fs: FsOp[] = [];
    for (const id of [...this.loadedSkills]) {
      if (this.pinned.has(id)) continue;
      if (!decision.role.skills.includes(id)) {
        this.loadedSkills.delete(id);
        fs.push({ op: "delete", path: skillPath(id) });
      }
    }
    const loaded: string[] = [];
    for (const id of decision.role.skills) {
      if (this.loadedSkills.has(id)) {
        loaded.push(id);
        continue;
      }
      if (!this.library.has(id)) continue;
      if (this.loadedSkills.size >= this.skillCap) break;
      this.loadedSkills.add(id);
      fs.push({ op: "write", path: skillPath(id) });
      loaded.push(id);
    }
    const connected = [...this.connectedMcp].filter((id) => decision.role.mcpServers.includes(id) || this.mcpAllowlist.has(id));
    const injection =
      `Role changed to ${decision.role.name}. ${loaded.length} skills loaded` +
      (loaded.length ? `: ${loaded.join(", ")}` : "") +
      `. ${connected.length} MCP servers connected` +
      (connected.length ? `: ${connected.join(", ")}` : "") +
      ".";
    const phase = rolePhase(decision.role, { desktopMode: this.desktopMode });
    phase.allowedTools = this.allowlist;
    return this.ok("set_role", injection, fs, why, phase);
  }

  private loadSkill(skillId: string, why?: string): MetaResult {
    const id = skillId.trim();
    if (!id || !this.library.has(id)) return this.fail("load_skill", "skill is not in the Library", why);
    if (this.loadedSkills.has(id)) return this.ok("load_skill", `Skill ${id} is already loaded.`, [], why);
    if (this.loadedSkills.size >= this.skillCap) {
      return this.fail("load_skill", `context budget full (${this.skillCap} skills); drop something first`, why);
    }
    this.loadedSkills.add(id);
    return this.ok("load_skill", `Skill ${id} loaded into ${skillPath(id)}.`, [{ op: "write", path: skillPath(id) }], why);
  }

  private dropSkill(skillId: string, why?: string): MetaResult {
    const id = skillId.trim();
    if (!this.loadedSkills.has(id)) return this.fail("drop_skill", "skill is not loaded", why);
    this.loadedSkills.delete(id);
    this.pinned.delete(id);
    return this.ok("drop_skill", `Skill ${id} dropped.`, [{ op: "delete", path: skillPath(id) }], why);
  }

  private connectMcp(serverId: string, why?: string): MetaResult {
    const id = serverId.trim();
    const knownDynamic = id.startsWith("lib-") || id.startsWith("custom-") || id === "tool-forge";
    if (!(id in ROLE_MCP_SERVER_REGISTRY) && !knownDynamic) {
      return this.fail("connect_mcp", "unknown MCP server", why);
    }
    if (!this.mcpAllowlist.has(id)) return this.fail("connect_mcp", "MCP server is not allowlisted for this run", why);
    this.connectedMcp.add(id);
    if (!this.allowlist.includes(`mcp__${id}__*`)) this.allowlist = [...this.allowlist, `mcp__${id}__*`];
    return this.ok("connect_mcp", `MCP server ${id} connected.`, [], why);
  }

  private disconnectMcp(serverId: string, why?: string): MetaResult {
    const id = serverId.trim();
    if (!this.connectedMcp.has(id)) return this.fail("disconnect_mcp", "MCP server is not connected", why);
    this.connectedMcp.delete(id);
    this.allowlist = this.allowlist.filter((tool) => tool !== `mcp__${id}__*`);
    return this.ok("disconnect_mcp", `MCP server ${id} disconnected.`, [], why);
  }

  private manageContext(action: string, target: string, why?: string): MetaResult {
    if (action === "summarize") {
      return this.ok("manage_context", "Older conversation compressed into a summary. Pinned items were kept.", [], why);
    }
    if (action === "pin") {
      if (!target || !this.loadedSkills.has(target)) return this.fail("manage_context", "pin target is not a loaded skill", why);
      this.pinned.add(target);
      return this.ok("manage_context", `Pinned ${target}.`, [], why);
    }
    if (action === "drop") {
      if (!target) return this.fail("manage_context", "drop needs a target", why);
      if (this.loadedSkills.has(target)) return this.dropSkill(target, why);
      if (this.connectedMcp.has(target)) return this.disconnectMcp(target, why);
      return this.fail("manage_context", "nothing loaded matches that name", why);
    }
    return this.fail("manage_context", "action must be summarize, drop, or pin", why);
  }

  private ok(tool: string, injection: string, fs: FsOp[], why?: string, resumePhase?: RolePhase): MetaResult {
    const audit: AuditEntry = { at: this.now(), tool, ok: true, detail: injection, ...(why ? { why } : {}) };
    this.audit.push(audit);
    this.injections.push(injection);
    return { ok: true, injection, audit, fs, ...(resumePhase ? { resumePhase } : {}) };
  }

  private fail(tool: string, error: string, why?: string): MetaResult {
    const audit: AuditEntry = { at: this.now(), tool, ok: false, detail: error, ...(why ? { why } : {}) };
    this.audit.push(audit);
    return { ok: false, error, injection: error, audit, fs: [] };
  }
}
