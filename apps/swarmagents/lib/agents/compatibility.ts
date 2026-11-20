/**
 * Capability detection + compatibility reporting (Agent Studio, phase 3).
 *
 * The report answers one question before a deploy: can *this* harness run
 * *this* manifest without lying to the user? Anything the manifest needs that
 * the harness cannot provide is `missing` (a deploy blocker); anything that is
 * merely unknown in this environment is a warning.
 *
 * Tool names come from lib/roles.ts (the same list the runtime turns into
 * `--allowedTools`) — never from a hand-written list here.
 */

import { CONNECTORS } from "../library/catalog";
import { catalogModelIds, isKnownModel, type AgentManifest } from "./manifest";
import { buildAgentCatalog } from "./catalog";
import { ROLE_TOOLS } from "../roles";

export interface CompatibilityReport {
  supported: string[];
  missing: string[];
  warnings: string[];
}

/** Tool permission strings the SwarmAgents harness can grant. */
export function harnessTools(): string[] {
  return [...new Set(ROLE_TOOLS.map((tool) => tool.claude))];
}

export interface DetectOptions {
  userId?: string;
}

/**
 * What this harness supports. Models come from the provider catalog, tools
 * from the role tool list; the rest is what the runtime genuinely implements
 * today.
 */
export function detectCapabilities(opts: DetectOptions = {}) {
  return {
    tools: harnessTools(),
    models: [...catalogModelIds()],
    supportsMcp: true,
    mcpTransports: ["stdio", "http", "sse"] as Array<"stdio" | "http" | "sse">,
    memoryPolicies: ["none", "session", "persistent"] as Array<"none" | "session" | "persistent">,
    supportsSubagents: harnessTools().includes("Task"),
    connectors: CONNECTORS.map((entry) => entry.id),
    // Per-account knowledge is only meaningful with a user id.
    ...(opts.userId ? { skills: [...buildAgentCatalog(opts.userId).skills] } : {}),
  };
}

/**
 * Compare one manifest against this harness.
 *
 * `missing` blocks a deploy: an unsupported tool, an unknown model, a skill the
 * account does not own, an MCP transport the harness cannot speak, a memory
 * policy it cannot honour.
 */
export function compatibilityReport(manifest: AgentManifest, opts: DetectOptions = {}): CompatibilityReport {
  const supported: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const tools = new Set(harnessTools());
  const models = catalogModelIds();
  const account = opts.userId ? buildAgentCatalog(opts.userId) : null;

  for (const tool of manifest.tools) {
    if (tools.has(tool)) supported.push(`tool ${tool}`);
    else missing.push(`tool ${tool} is not supported by this harness`);
  }
  for (const tool of manifest.permissions.allowTools) {
    if (tools.has(tool)) supported.push(`permission ${tool}`);
    else missing.push(`permission ${tool} is not supported by this harness`);
  }
  for (const tool of manifest.permissions.denyTools) {
    if (!tools.has(tool)) warnings.push(`denied tool ${tool} is unknown to this harness (harmless)`);
  }

  if (isKnownModel(manifest.models.preferred, models)) supported.push(`model ${manifest.models.preferred}`);
  else missing.push(`model ${manifest.models.preferred} is not in the provider catalog`);
  for (const fallback of manifest.models.fallbacks) {
    if (isKnownModel(fallback, models)) supported.push(`fallback ${fallback}`);
    else missing.push(`fallback model ${fallback} is not in the provider catalog`);
  }
  if (account && account.models.size > 0) {
    // Catalog membership is not account ownership; the UI shows this so a user
    // knows they may need to add the provider key before the run can route.
    if (!account.models.has(manifest.models.preferred)) {
      warnings.push(`model ${manifest.models.preferred} is valid but may need a provider key in this account`);
    }
  }

  if (account) {
    for (const skill of manifest.skills) {
      if (account.skills.has(skill)) supported.push(`skill ${skill}`);
      else missing.push(`skill ${skill} is not installed in this account`);
    }
  } else if (manifest.skills.length > 0) {
    warnings.push("skills were not checked against an account library");
  }

  for (const workflow of manifest.workflows) {
    if (!account) {
      warnings.push(`workflow ${workflow} was not checked against an account catalog`);
      continue;
    }
    if (account.workflows.has(workflow)) supported.push(`workflow ${workflow}`);
    else missing.push(`workflow ${workflow} does not exist`);
  }

  for (const server of manifest.mcp) {
    if (!["stdio", "http", "sse"].includes(server.transport)) {
      missing.push(`MCP transport ${server.transport} is not supported`);
      continue;
    }
    if (server.transport === "stdio" && !server.command) {
      warnings.push(`MCP server ${server.name} is stdio without a command`);
    }
    if (server.transport !== "stdio" && !server.url) {
      warnings.push(`MCP server ${server.name} is ${server.transport} without a url`);
    }
    supported.push(`mcp ${server.name}`);
  }

  const connectors = new Set(CONNECTORS.map((entry) => entry.id));
  for (const connector of manifest.connectors) {
    if (connectors.has(connector)) supported.push(`connector ${connector}`);
    else warnings.push(`connector ${connector} is not available in this environment`);
  }

  if (!["none", "session", "persistent"].includes(manifest.memory.policy)) {
    missing.push(`memory policy ${manifest.memory.policy} is not supported`);
  } else {
    supported.push(`memory ${manifest.memory.policy}`);
  }

  if (manifest.subagents.length > 0) {
    if (harnessTools().includes("Task")) {
      for (const sub of manifest.subagents) {
        for (const tool of sub.tools) {
          if (!tools.has(tool)) missing.push(`subagent ${sub.name} tool ${tool} is not supported by this harness`);
        }
        if (sub.model && !isKnownModel(sub.model, models)) {
          missing.push(`subagent ${sub.name} model ${sub.model} is not in the provider catalog`);
        }
        supported.push(`subagent ${sub.name}`);
      }
    } else {
      missing.push("subagents are not supported by this harness");
    }
  }

  return { supported, missing, warnings };
}
