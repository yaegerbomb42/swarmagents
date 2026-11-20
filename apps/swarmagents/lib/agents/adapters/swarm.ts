/**
 * SwarmAgents harness adapter (Agent Studio, phase 3).
 *
 * Translates one manifest into one run in a SwarmAgents Docker VM. Two rules
 * matter more than the mapping itself:
 *
 *  - Permissions are enforced by the runtime, not by instructions: the run gets
 *    `tools ∩ harnessTools` minus `denyTools` as its `toolAllowlist`, so an
 *    agent can never reach a tool its manifest excluded, whatever its prompt says.
 *  - The preferred model is not silently retried or swapped. If the manifest is
 *    not compatible, the deploy is refused with the list of what is missing;
 *    fallback selection is a runtime concern, not a deploy-time guess.
 */

import { getRuntimeManager, type RuntimeManager } from "../../runtime/manager";
import { compatibilityReport, detectCapabilities, harnessTools } from "../compatibility";
import type { AgentManifest } from "../manifest";
import type { AdapterCapabilities, AdapterDeps, DeployFailure, DeployResult, HarnessAdapter } from "./types";

export interface SwarmDeployDeps {
  manager?: RuntimeManager;
}

/** The tool allowlist a manifest actually gets on this harness. */
export function effectiveToolAllowlist(manifest: AgentManifest): string[] {
  const harness = new Set(harnessTools());
  const denied = new Set(manifest.permissions.denyTools);
  const wanted = [...manifest.tools, ...manifest.permissions.allowTools];
  return [...new Set(wanted)].filter((tool) => harness.has(tool) && !denied.has(tool));
}

/**
 * The prompt the run starts with. The system prompt leads; the manifest's
 * skills, tools and policies are appended as explicit operating notes so the
 * agent knows how it is allowed to work.
 */
export function buildDeployPrompt(manifest: AgentManifest): string {
  const lines: string[] = [manifest.identity.systemPrompt.trim()];
  if (manifest.identity.tone) lines.push(`Tone: ${manifest.identity.tone.trim()}`);
  const tools = effectiveToolAllowlist(manifest);
  if (tools.length > 0) lines.push(`Tools available to you: ${tools.join(", ")}.`);
  if (manifest.skills.length > 0) {
    lines.push(`Skills installed for this run (from the library): ${manifest.skills.join(", ")}.`);
  }
  if (manifest.mcp.length > 0) {
    lines.push(`MCP servers configured: ${manifest.mcp.map((server) => `${server.name} (${server.transport})`).join(", ")}.`);
  }
  if (manifest.connectors.length > 0) {
    lines.push(`Connectors you may be asked to use: ${manifest.connectors.join(", ")}.`);
  }
  if (manifest.memory.policy !== "none") {
    lines.push("Use the memory tools to remember durable preferences between runs.");
  }
  if (manifest.permissions.allowTools.length > 0) {
    lines.push(`Extra permissions granted: ${manifest.permissions.allowTools.join(", ")}.`);
  }
  if (manifest.permissions.denyTools.length > 0) {
    lines.push(`Never use: ${manifest.permissions.denyTools.join(", ")} — the runtime will block it.`);
  }
  if (typeof manifest.policies.maxTurns === "number") {
    lines.push(`Work within ${manifest.policies.maxTurns} turns.`);
  }
  return lines.join("\n\n");
}

/** A one-line card shown in the run list, so a deployed agent is identifiable. */
export function buildAgentCard(manifest: AgentManifest): string {
  const description = manifest.description ? ` — ${manifest.description}` : "";
  return `Agent "${manifest.name}"${description}`;
}

export const swarmAdapter: HarnessAdapter = {
  id: "swarm",
  name: "SwarmAgents VM",
  capabilities(): AdapterCapabilities {
    const detected = detectCapabilities();
    return {
      tools: detected.tools,
      models: detected.models,
      supportsMcp: detected.supportsMcp,
      mcpTransports: detected.mcpTransports,
      memoryPolicies: detected.memoryPolicies,
      supportsSubagents: detected.supportsSubagents,
      connectors: detected.connectors,
    };
  },
  async deploy(userId: string, manifest: AgentManifest, deps: AdapterDeps = {}) {
    const report = compatibilityReport(manifest, { userId });
    if (report.missing.length > 0) {
      const failure: DeployFailure = {
        ok: false,
        error: `This agent cannot deploy to SwarmAgents: ${report.missing.join("; ")}`,
        missing: report.missing,
      };
      return failure;
    }
    const manager = (deps as SwarmDeployDeps).manager ?? getRuntimeManager();
    const toolAllowlist = effectiveToolAllowlist(manifest);
    let started;
    try {
      started = manager.start(userId, {
        prompt: buildDeployPrompt(manifest),
        agentCard: buildAgentCard(manifest),
        model: manifest.models.preferred,
        ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "The harness refused to start the run." };
    }
    if (!started.accepted || !started.runId) {
      return { ok: false, error: started.error ?? "The harness did not accept the run." };
    }
    const result: DeployResult = { ok: true, runId: started.runId, queued: started.queued };
    return result;
  },
};

/** All harness adapters this build ships. Phase 7 adds a second entry here. */
export function harnessAdapters(): HarnessAdapter[] {
  return [swarmAdapter];
}
