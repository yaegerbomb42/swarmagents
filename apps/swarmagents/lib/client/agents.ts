/**
 * Browser client for the Agent Studio API.
 *
 * Types are duplicated client-safe (the server store imports node:fs, so the
 * browser must never pull it in). Every call is same-origin and credentialed
 * by the session cookie; the API only ever answers with the caller's agents.
 */

import type { AgentManifest } from "../agents/manifest";

export type { AgentManifest };

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  version: number;
  updatedAt: number;
}

export interface AgentHistoryRow {
  versionIndex: number;
  savedAt: number;
  name: string;
  systemPromptLength: number;
  models: { preferred: string; fallbacks: string[] };
}

export interface CompatibilityReportView {
  supported: string[];
  missing: string[];
  warnings: string[];
}

export interface HarnessView {
  id: string;
  name: string;
  capabilities: {
    tools: string[];
    models: string[];
    supportsMcp: boolean;
    mcpTransports: string[];
    memoryPolicies: string[];
    supportsSubagents: boolean;
    connectors: string[];
  };
}

export interface AgentExportPackage {
  format: "swarm-agent";
  formatVersion: 1;
  exportedAt: string;
  agent: AgentManifest;
}

export class AgentApiError extends Error {
  readonly status: number;
  readonly details: { errors?: string[]; missing?: string[]; warnings?: string[] };

  constructor(message: string, status: number, details: { errors?: string[]; missing?: string[]; warnings?: string[] } = {}) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    this.details = details;
  }
}

function detailArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (HTTP ${res.status}).`;
    throw new AgentApiError(message, res.status, {
      errors: detailArray(body.errors),
      missing: detailArray(body.missing),
      warnings: detailArray(body.warnings),
    });
  }
  return body as T;
}

export const agentsApi = {
  list: () => request<{ agents: AgentSummary[] }>("/api/agents"),
  get: (id: string) => request<{ agent: AgentManifest }>(`/api/agents/${encodeURIComponent(id)}`),
  create: (manifest: AgentManifest) =>
    request<{ agent: AgentManifest; warnings: string[] }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(manifest),
    }),
  replace: (id: string, manifest: AgentManifest) =>
    request<{ agent: AgentManifest; warnings: string[] }>(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(manifest),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  clone: (id: string, newId?: string) =>
    request<{ agent: AgentManifest }>(`/api/agents/${encodeURIComponent(id)}/clone`, {
      method: "POST",
      body: JSON.stringify(newId ? { newId } : {}),
    }),
  exportPackage: (id: string) => request<AgentExportPackage>(`/api/agents/${encodeURIComponent(id)}/export`),
  importPackage: (pkg: unknown) =>
    request<{ agent: AgentManifest; warnings: string[] }>("/api/agents/import", {
      method: "POST",
      body: JSON.stringify(pkg),
    }),
  history: (id: string) => request<{ history: AgentHistoryRow[] }>(`/api/agents/${encodeURIComponent(id)}/history`),
  restore: (id: string, versionIndex: number) =>
    request<{ agent: AgentManifest }>(`/api/agents/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ versionIndex }),
    }),
  compatibility: (id: string) =>
    request<{ harness: string; capabilities: HarnessView["capabilities"]; report: CompatibilityReportView }>(
      `/api/agents/${encodeURIComponent(id)}/compatibility`,
    ),
  deploy: (id: string, harness = "swarm") =>
    request<{ runId: string; queued: boolean; harness: string; report: CompatibilityReportView }>(
      `/api/agents/${encodeURIComponent(id)}/deploy`,
      { method: "POST", body: JSON.stringify({ harness }) },
    ),
  harnesses: () => request<{ harnesses: HarnessView[] }>("/api/agents/harnesses"),
};
