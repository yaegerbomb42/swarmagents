/**
 * What one account's environment knows about, for manifest validation.
 *
 * Models come from the provider catalog (static). Skills and MCP servers come
 * from the account's installed library, so an agent can only reference things
 * this user actually owns. Connectors come from the shipped connector catalog.
 */

import { CONNECTORS } from "../library/catalog";
import { listInstalledItems } from "../library/user-store";
import { catalogModelIds, emptyAgentCatalog, type AgentCatalog } from "./manifest";

export function buildAgentCatalog(userId: string): AgentCatalog {
  const catalog = emptyAgentCatalog();
  catalog.connectors = new Set(CONNECTORS.map((entry) => entry.id));
  try {
    for (const item of listInstalledItems(userId)) {
      if (item.kind === "skill") catalog.skills.add(item.id);
      if (item.kind === "mcp") catalog.mcpServers.add(item.id);
    }
  } catch {
    // A broken library file must not make agents unusable: fall back to
    // "unknown" so validation reports the skill as missing rather than crashing.
  }
  return catalog;
}

/** Model ids only — used where the caller has no account context. */
export function globalAgentCatalog(): AgentCatalog {
  return { ...emptyAgentCatalog(), connectors: new Set(CONNECTORS.map((entry) => entry.id)) };
}

export { catalogModelIds };
