/**
 * Per-account Capability Atlas VM registry builder.
 *
 * Indexes the account's verified MCP connectors (40+ catalog servers),
 * installed custom & agent-authored Library MCPs/tools, and core VM CLIs into
 * a secret-free CapabilityEntry[] payload ready for /workspace/.swarm/atlas/registry.json.
 *
 * Agents query this via capability-atlas (`find_capability` / `describe_capability`)
 * at ~15-25 tokens per result instead of loading hundreds of tool schemas.
 */

import { CONNECTOR_CATALOG } from "../connectors/catalog";
import { listConnectorStatuses } from "../connectors/store";
import { listInstalledItems } from "../library/user-store";
import type { CapabilityEntry } from "./schema";

export const VM_ATLAS_REGISTRY_PATH = "/workspace/.swarm/atlas/registry.json";

const CORE_VM_CAPABILITIES: readonly CapabilityEntry[] = [
  {
    id: "cli:git",
    kind: "cli",
    name: "git",
    summary: "Version control: status, diff, commit, branch, rebase, log inside /workspace.",
    risk: "writes-files",
    source: "vm-builtin",
  },
  {
    id: "cli:rg",
    kind: "cli",
    name: "ripgrep (rg)",
    summary: "Fast regex search across workspace source files and AST symbol locations.",
    risk: "read-only",
    source: "vm-builtin",
  },
  {
    id: "cli:node",
    kind: "cli",
    name: "node / tsx",
    summary: "Execute JavaScript/TypeScript scripts, unit tests (tsx --test), and build tools.",
    risk: "writes-files",
    source: "vm-builtin",
  },
  {
    id: "cli:python3",
    kind: "cli",
    name: "python3",
    summary: "Run Python data processing, automation scripts, and Playwright/HTTP tooling.",
    risk: "writes-files",
    source: "vm-builtin",
  },
  {
    id: "mcp:tool-forge",
    kind: "mcp_tool",
    name: "tool-forge (search_mcp_catalog, author_tool, list_my_tools, manage_mcp)",
    summary: "Search 40+ MCP connectors, author & test custom Node/Python/Bash tools, and manage VM MCPs.",
    risk: "writes-files",
    source: "tool-forge",
  },
];

export function buildUserVmAtlasEntries(userId: string): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [...CORE_VM_CAPABILITIES];
  const seenIds = new Set<string>(entries.map((e) => e.id));

  let statuses: ReturnType<typeof listConnectorStatuses>;
  try {
    statuses = listConnectorStatuses(userId);
  } catch {
    statuses = CONNECTOR_CATALOG.map((c) => ({
      ...c,
      connected: false,
      providerConnected: false,
      mcpInstalled: false,
      vaultConfigured: false,
      canActivateFromProvider: false,
      canOneClickConnect: c.fields.length === 0,
    }));
  }

  for (const conn of statuses) {
    const id = `connector:${conn.id}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const stateLabel = conn.connected
      ? "[CONNECTED]"
      : conn.canOneClickConnect
        ? "[1-CLICK READY]"
        : "[NEEDS KEY]";
    entries.push({
      id,
      kind: "mcp_tool",
      name: `${conn.name} (${conn.id})`,
      summary: `${stateLabel} ${conn.unlocks}`.slice(0, 220),
      risk: conn.isFree && conn.fields.length === 0 ? "network" : "network",
      source: conn.libraryConnectorId ?? conn.id,
    });
  }

  try {
    const installed = listInstalledItems(userId);
    for (const item of installed) {
      const id = `library:${item.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      entries.push({
        id,
        kind: "mcp_tool",
        name: `${item.name} (${item.id})`,
        summary: `[INSTALLED ${item.origin.toUpperCase()}] ${item.description}`.slice(0, 220),
        risk: "network",
        source: item.id,
      });
    }
  } catch {
    // Missing/unauthenticated user library fails open with catalog entries.
  }

  return entries;
}

export function serializeUserVmAtlasRegistry(userId: string): string {
  const entries = buildUserVmAtlasEntries(userId);
  return JSON.stringify(
    {
      schema: "swarm.capability-atlas",
      version: 1,
      generatedAt: Date.now(),
      entries,
    },
    null,
    2,
  );
}
