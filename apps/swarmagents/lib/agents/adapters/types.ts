/**
 * Harness adapter interface (Agent Studio, phase 3).
 *
 * The manifest is harness-agnostic, so every harness is reached through an
 * adapter that declares what it can actually do and translates one manifest
 * into one deployment. Capabilities are derived from the real harness, never
 * from the manifest.
 */

import type { AgentManifest } from "../manifest";

export interface AdapterCapabilities {
  /** Tool permission strings this harness can grant (Claude Code names). */
  tools: string[];
  /** Model ids this harness can route to. */
  models: string[];
  supportsMcp: boolean;
  /** MCP transports the harness can speak. */
  mcpTransports: Array<"stdio" | "http" | "sse">;
  memoryPolicies: Array<"none" | "session" | "persistent">;
  supportsSubagents: boolean;
  connectors: string[];
}

export interface DeployResult {
  ok: true;
  runId: string;
  queued: boolean;
}

export interface DeployFailure {
  ok: false;
  error: string;
  /** Compatibility entries that blocked the deploy, when there are any. */
  missing?: string[];
}

/** Per-adapter injectable dependencies (tests pass a fake runtime manager). */
export type AdapterDeps = Record<string, unknown>;

export interface HarnessAdapter {
  id: string;
  name: string;
  /** What this harness supports right now (derived from the real code). */
  capabilities(): AdapterCapabilities;
  /** Start the agent on this harness. */
  deploy(userId: string, manifest: AgentManifest, deps?: AdapterDeps): Promise<DeployResult | DeployFailure>;
}
