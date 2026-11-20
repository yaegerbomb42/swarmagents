/**
 * Pure helpers behind the Agent Studio builder (phase 6).
 *
 * The repo has no DOM test setup, so the builder keeps every decision that can
 * be wrong in these pure functions and the component only renders them. That is
 * the same split as `teamLaneDetail.ts`.
 */

import type { AgentManifest } from "../../../lib/agents/manifest";
import type { AgentSummary, CompatibilityReportView } from "../../../lib/client/agents";

export interface AgentMcpRow {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  url: string;
}

export interface AgentSubagentRow {
  name: string;
  instructions: string;
  tools: string;
}

/** The builder's editable shape: everything a form needs, strings only. */
export interface AgentFormState {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tone: string;
  preferredModel: string;
  fallbackModels: string[];
  tools: string[];
  mcp: AgentMcpRow[];
  connectors: string[];
  context: string;
  memoryPolicy: "none" | "session" | "persistent";
  maxEntries: string;
  skills: string[];
  workflows: string;
  maxTurns: string;
  maxCostUsd: string;
  approvalRequired: boolean;
  denyTools: string[];
  subagents: AgentSubagentRow[];
}

export const EMPTY_FORM: AgentFormState = {
  id: "",
  name: "",
  description: "",
  systemPrompt: "",
  tone: "",
  preferredModel: "",
  fallbackModels: [],
  tools: [],
  mcp: [],
  connectors: [],
  context: "",
  memoryPolicy: "session",
  maxEntries: "",
  skills: [],
  workflows: "",
  maxTurns: "",
  maxCostUsd: "",
  approvalRequired: false,
  denyTools: [],
  subagents: [],
};

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Turn a stored manifest into form state (a new agent yields EMPTY_FORM). */
export function formFromManifest(manifest?: AgentManifest | null): AgentFormState {
  if (!manifest) return { ...EMPTY_FORM };
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? "",
    systemPrompt: manifest.identity.systemPrompt,
    tone: manifest.identity.tone ?? "",
    preferredModel: manifest.models.preferred,
    fallbackModels: [...manifest.models.fallbacks],
    tools: [...manifest.tools],
    mcp: manifest.mcp.map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command ?? "",
      url: server.url ?? "",
    })),
    connectors: [...manifest.connectors],
    context: manifest.context.join(", "),
    memoryPolicy: manifest.memory.policy,
    maxEntries: manifest.memory.maxEntries !== undefined ? String(manifest.memory.maxEntries) : "",
    skills: [...manifest.skills],
    workflows: manifest.workflows.join(", "),
    maxTurns: manifest.policies.maxTurns !== undefined ? String(manifest.policies.maxTurns) : "",
    maxCostUsd: manifest.policies.maxCostUsd !== undefined ? String(manifest.policies.maxCostUsd) : "",
    approvalRequired: manifest.permissions.approvalRequired,
    denyTools: [...manifest.permissions.denyTools],
    subagents: manifest.subagents.map((sub) => ({
      name: sub.name,
      instructions: sub.instructions,
      tools: sub.tools.join(", "),
    })),
  };
}

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Turn form state back into a manifest. The server validates; this only has to
 * be structurally honest (no `undefined` keys, no empty id, no NaN).
 */
export function manifestFromForm(form: AgentFormState): AgentManifest {
  const id = form.id.trim();
  const maxEntries = numberOrUndefined(form.maxEntries);
  const maxTurns = numberOrUndefined(form.maxTurns);
  const maxCostUsd = numberOrUndefined(form.maxCostUsd);
  return {
    version: 1,
    id,
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    identity: {
      systemPrompt: form.systemPrompt,
      ...(form.tone.trim() ? { tone: form.tone.trim() } : {}),
    },
    models: { preferred: form.preferredModel.trim(), fallbacks: [...form.fallbackModels] },
    tools: [...form.tools],
    mcp: form.mcp
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        transport: row.transport,
        ...(row.transport === "stdio"
          ? { command: row.command.trim() }
          : { url: row.url.trim() }),
      })),
    connectors: [...form.connectors],
    context: splitList(form.context),
    memory: {
      policy: form.memoryPolicy,
      ...(maxEntries !== undefined ? { maxEntries } : {}),
    },
    skills: [...form.skills],
    workflows: splitList(form.workflows),
    policies: {
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
    permissions: {
      allowTools: [...form.tools],
      denyTools: [...form.denyTools],
      approvalRequired: form.approvalRequired,
    },
    subagents: form.subagents
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        instructions: row.instructions,
        tools: splitList(row.tools),
      })),
  };
}

/** Library search: name or description, case-insensitive. */
export function filterAgents(agents: AgentSummary[], query: string): AgentSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return agents;
  return agents.filter((agent) => {
    const haystack = `${agent.name} ${agent.description ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export interface CompatibilityDigest {
  ok: boolean;
  headline: string;
  supported: string[];
  missing: string[];
  warnings: string[];
}

/** What the "Check compatibility" panel shows, derived from the API report. */
export function digestCompatibility(report: CompatibilityReportView): CompatibilityDigest {
  if (report.missing.length > 0) {
    return {
      ok: false,
      headline: `${report.missing.length} problem${report.missing.length === 1 ? " blocks" : "s block"} deployment`,
      supported: report.supported,
      missing: report.missing,
      warnings: report.warnings,
    };
  }
  const warn = report.warnings.length;
  return {
    ok: true,
    headline: warn === 0 ? "Ready to deploy" : `Ready to deploy with ${warn} warning${warn === 1 ? "" : "s"}`,
    supported: report.supported,
    missing: [],
    warnings: report.warnings,
  };
}

/** Stable id from a display name, for "create from name" convenience. */
export function idFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
