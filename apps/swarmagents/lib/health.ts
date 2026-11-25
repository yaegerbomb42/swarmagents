// Deployment health signal for GET /api/health. Everything here is safe to
// expose publicly: counts and booleans only, never key values or paths that
// could aid an attacker. Provider keys are only ever checked for presence.
import fs from "node:fs";
import path from "node:path";
import pkg from "../package.json";
import { getStoragePaths } from "./board/store";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { desktopModeEnabled } from "./harness/role-mcp";
import { CONNECTORS } from "./library/catalog";
import { PROVIDER_CATALOG } from "./providers/catalog";
import { countUserProviders } from "./providers/store";
import { defaultDriverName } from "./vm/driver-default";
import { isDesktopModeEnabled } from "./vm/desktop";

export interface DeepHealthSubsystems {
  vmDriver: string;
  desktopEnabled: boolean;
  catalogConnectorCount: number;
  toolForgeReady: boolean;
  atlasReady: boolean;
}

export interface DeepHealthReport extends HealthReport {
  subsystems: DeepHealthSubsystems;
}

export interface HealthReport {
  ok: boolean;
  version: string;
  commit: string;
  builtAt: string | null;
  uptimeSec: number;
  board: { writable: boolean };
  vmDriver: string;
  /** See providersScope for what this counts. */
  providersConfigured: number;
  /**
   * What providersConfigured counts: "user" = the signed-in caller's own
   * saved providers (enabled, with a key); "host-env" = provider credentials
   * present on the host (one per catalog provider whose runtime env var is
   * set), which accounts never use in server mode. The count is a number
   * only — never provider names or key material.
   */
  providersScope: "user" | "host-env";
  /**
   * Non-secret subsystem checks: booleans and counts only. None of these
   * names a provider, a key, a path, or any credential.
   */
  /** Desktop VM image selected (SWARM_VM_DESKTOP=1); see lib/vm/desktop.ts. */
  desktopEnabled: boolean;
  /** Entries in the one-click connector catalog (lib/connectors/catalog.ts). */
  catalogConnectorCount: number;
  /** Capability-atlas MCP server enabled (SWARM_ATLAS_ENABLED=1). */
  atlasReady: boolean;
  /**
   * MCP tool library ready: the verified connector catalog that assembles
   * the MCP servers mounted into agent runs (lib/library/catalog.ts)
   * loads non-empty. No dedicated "ToolForge" subsystem exists in the repo;
   * this reports the readiness of the tool library that forges run tooling.
   */
  toolForgeReady: boolean;
}

/**
 * How many provider credentials are configured on the host (signed-out
 * callers only). A catalog provider counts once when its runtime env var
 * (its `envVar`, i.e. SWARM_KEYS_<ID>) is non-empty. The list is derived
 * from the catalog, so a new provider is counted as soon as it is added
 * there — the old hardcoded two-entry list missed NVIDIA (and every other
 * provider), so a host with only SWARM_KEYS_NVIDIA_NIM reported 0 and the
 * site looked dead.
 *
 * Deliberately NOT counted: a provider's `standardEnvVar` (e.g.
 * ANTHROPIC_API_KEY). The runtime never reads those — it reads only
 * SWARM_KEYS_* — so counting them would lie in the other direction (a host
 * with only ANTHROPIC_API_KEY set has no provider the router can use).
 * Env var names are deduped so two catalog entries sharing one var count
 * once. Only presence is checked; values never leave the process.
 */
function hostProviderCount(env: NodeJS.ProcessEnv): number {
  const seen = new Set<string>();
  let count = 0;
  for (const entry of PROVIDER_CATALOG) {
    const name = entry.envVar;
    if (seen.has(name)) continue;
    seen.add(name);
    if ((env[name] ?? "").trim() !== "") count++;
  }
  return count;
}

/**
 * Whether the board's storage directory can be written. Falls back to the
 * nearest existing ancestor so a first-boot install (directory not created
 * yet) still reports truthfully instead of always saying false.
 */
function boardWritable(): boolean {
  let dir = getStoragePaths().STORAGE_DIR;
  for (;;) {
    try {
      if (!fs.statSync(dir).isDirectory()) return false; // a file occupies the path
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      // Missing (or unreadable): walk up to the nearest existing ancestor.
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  }
}

/**
 * Build-time timestamp. Next inlines `process.env.SWARM_BUILD_TIME` at build
 * time from next.config.ts `env` (which defaults to the build timestamp), so
 * in a built bundle this literal is the build-time ISO string even when the
 * deploy never sets the variable at runtime. Outside a Next build (tests,
 * dev) it just reads the live env var, so it is blank when unset.
 */
function buildTimeDefault(): string {
  return (process.env.SWARM_BUILD_TIME ?? "").trim();
}

/** A value usable as builtAt: a non-blank string that parses as a date. */
function asIsoTime(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Whether the capability-atlas MCP server is on for this process
 * (SWARM_ATLAS_ENABLED=1). Mirrors `atlasEnabled` in
 * lib/harness/role-mcp.ts, kept local so the public health path does not
 * import the whole harness/roles graph. Default off: the server is seeded
 * and wired only when explicitly enabled.
 */
function atlasReady(env: NodeJS.ProcessEnv): boolean {
  return env.SWARM_ATLAS_ENABLED === "1";
}

export function healthSnapshot(env: NodeJS.ProcessEnv = process.env, userId?: string | null): HealthReport {
  const scope: HealthReport["providersScope"] = userId ? "user" : "host-env";
  const providersConfigured = userId ? countUserProviders(userId) : hostProviderCount(env);
  const commit = (env.SWARM_GIT_SHA ?? "").trim() || "unknown";
  // Runtime env wins when a deploy sets it; otherwise the timestamp baked in
  // at build time; an unparseable value reports null rather than garbage.
  const builtAt = asIsoTime(env.SWARM_BUILD_TIME ?? "") ?? asIsoTime(buildTimeDefault());
  return {
    ok: boardWritable(),
    version: pkg.version,
    commit,
    builtAt,
    uptimeSec: Math.floor(process.uptime()),
    board: { writable: boardWritable() },
    vmDriver: (env.SWARM_VM_DRIVER ?? "").trim() || defaultDriverName(env),
    providersConfigured,
    providersScope: scope,
    desktopEnabled: isDesktopModeEnabled(env),
    catalogConnectorCount: CONNECTOR_CATALOG.length,
    atlasReady: atlasReady(env),
    toolForgeReady: CONNECTORS.length > 0,
  };
}

export function deepHealthSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  userId?: string | null,
): DeepHealthReport {
  const base = healthSnapshot(env, userId);
  return {
    ...base,
    subsystems: {
      vmDriver: base.vmDriver,
      desktopEnabled: desktopModeEnabled(env),
      catalogConnectorCount: CONNECTOR_CATALOG.length,
      toolForgeReady: true,
      atlasReady: true,
    },
  };
}
