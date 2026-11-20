/**
 * Browser client for the Library API.
 *
 * Types are duplicated in a client-safe way (the server modules import
 * node:fs, so the browser must not pull them in). Every call sends cookies
 * with the session; the API answers with the caller's own data only.
 */

import type { LibraryKind, LibraryPayload, ModerationState, SecretField } from "../library/types";

export interface PublicItemSummary {
  id: string;
  kind: LibraryKind;
  name: string;
  description: string;
  license: string;
  authorHandle: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  installs: number;
  moderation: ModerationState;
  reported: boolean;
  reportCount: number;
  /**
   * F4: true only when the current version carries a signed proof-of-run
   * bundle that verifies against this exact version's payload.
   */
  proofVerified: boolean;
}

export interface ProofShotView {
  index: number;
  file: string;
  mime: string;
  seq: number;
  ts: number;
  label: string;
  size: number;
  url: string;
}

/** Client-safe view of a verified F4 proof-of-run bundle. */
export interface ProofView {
  verified: true;
  format: string;
  publicId: string;
  version: number;
  kind: LibraryKind;
  name: string;
  runId: string;
  runStatus: "finished" | "error" | "cancelled";
  vmImage: string;
  prompt: string;
  createdAt: number;
  finishedAt: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  providers: string[];
  steps: Array<{ seq: number; ts: number; kind: string; text: string; ok?: boolean }>;
  artifacts: Array<{ path: string; rel: string; size: number; mtimeMs: number; change: "created" | "modified" }>;
  shots: ProofShotView[];
  shotsTotal: number;
  issuedAt: number;
}

export interface PublicItemDetail extends PublicItemSummary {
  payload: LibraryPayload;
  requiredFields: SecretField[];
  isOwner: boolean;
  canUnpublish: boolean;
  /** Verified proof bundle for the current version, when one verifies. */
  proof?: ProofView;
}

/** Client-safe view of one F4 test-drive, including its run's outcome. */
export interface TestDriveView {
  id: string;
  publicId: string;
  publicName: string;
  version: number;
  snapshotLabel: string;
  runId: string;
  status: "running" | "awaiting-decision" | "kept" | "rolled-back";
  startedAt: number;
  finishedAt?: number;
  rollbackReason?: "user" | "run-failed" | "superseded" | "start-refused" | "abandoned";
  lastError?: string;
  runStatus: string;
  report?: {
    status: "finished" | "error" | "cancelled";
    costUsd?: number;
    durationMs?: number;
    model?: string;
    providers: string[];
    steps: Array<{ seq: number; ts: number; kind: string; text: string; ok?: boolean }>;
    artifacts: Array<{ path: string; rel: string; size: number; mtimeMs: number; change: "created" | "modified" }>;
    couldNotDo: string[];
    shots: number;
  };
}

export interface InstalledSecretField extends SecretField {
  configured: boolean;
  mask?: string;
}

export interface InstalledItem {
  id: string;
  kind: LibraryKind;
  name: string;
  description: string;
  license?: string;
  version: number;
  sourcePublicId?: string;
  origin: "user" | "agent" | "public";
  createdAt: number;
  updatedAt: number;
  payload: LibraryPayload;
  secretFields: InstalledSecretField[];
  updateAvailable?: boolean;
  latestVersion?: number;
}

export interface LibraryNotification {
  itemId: string;
  name: string;
  fromVersion: number;
  toVersion: number;
  sourcePublicId: string | null;
}

export interface ConnectorEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  transport: "stdio" | "http";
  install: string;
  requiredFields: Array<{ key: string; label: string; secret: boolean; helpUrl?: string }>;
  auth: string;
  tools: string[];
  sourceUrl?: string;
  verified: boolean;
  verifiedHow?: string;
  installed?: boolean;
  canInstall?: boolean;
}

export class LibraryApiError extends Error {
  readonly status: number;
  readonly missingFields: string[];

  constructor(message: string, status: number, missingFields: string[] = []) {
    super(message);
    this.name = "LibraryApiError";
    this.status = status;
    this.missingFields = missingFields;
  }
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
    const missing = Array.isArray(body.missingFields)
      ? body.missingFields.filter((field): field is string => typeof field === "string")
      : [];
    throw new LibraryApiError(message, res.status, missing);
  }
  return body as T;
}

export const libraryApi = {
  me: () => request<{ user: string; admin: boolean; publishLimitPerHour: number }>("/api/library/me"),

  listPublic: (params: { q?: string; kind?: string; sort?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.kind && params.kind !== "all") search.set("kind", params.kind);
    if (params.sort) search.set("sort", params.sort);
    const suffix = search.toString();
    return request<{
      items: PublicItemSummary[];
      total: number;
      canModerate: boolean;
      publishLimitPerHour: number;
    }>(`/api/library/public${suffix ? `?${suffix}` : ""}`);
  },

  getPublic: (id: string) => request<{ item: PublicItemDetail }>(`/api/library/public/${encodeURIComponent(id)}`),

  publish: (body: Record<string, unknown>) =>
    request<{ item: PublicItemDetail; remaining?: number }>("/api/library/public", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  publishVersion: (id: string, body: Record<string, unknown>) =>
    request<{ item: PublicItemDetail }>(`/api/library/public/${encodeURIComponent(id)}/versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  install: (id: string, secrets?: Record<string, string>) =>
    request<{ installed: boolean; item: InstalledItem; publicItem: PublicItemSummary }>(
      `/api/library/public/${encodeURIComponent(id)}/install`,
      { method: "POST", body: JSON.stringify(secrets ? { secrets } : {}) },
    ),

  report: (id: string, reason: string) =>
    request<{ reported: boolean; reportCount: number }>(`/api/library/public/${encodeURIComponent(id)}/report`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  unpublish: (id: string) =>
    request<{ unpublished: boolean }>(`/api/library/public/${encodeURIComponent(id)}/unpublish`, {
      method: "POST",
      body: "{}",
    }),

  review: (id: string) =>
    request<{ reviewed: boolean }>(`/api/library/public/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: "{}",
    }),

  startTestDrive: (id: string, prompt?: string) =>
    request<{ drive: TestDriveView; runId: string; snapshotLabel: string; queued?: boolean }>(
      `/api/library/public/${encodeURIComponent(id)}/test-drive`,
      { method: "POST", body: JSON.stringify({ action: "start", ...(prompt ? { prompt } : {}) }) },
    ),

  getTestDrive: (id: string, driveId: string) =>
    request<{ drive: TestDriveView }>(
      `/api/library/public/${encodeURIComponent(id)}/test-drive?driveId=${encodeURIComponent(driveId)}`,
    ),

  listTestDrives: (id: string) =>
    request<{ drives: TestDriveView[] }>(`/api/library/public/${encodeURIComponent(id)}/test-drive`),

  keepTestDrive: (id: string, driveId: string) =>
    request<{ drive: TestDriveView }>(`/api/library/public/${encodeURIComponent(id)}/test-drive`, {
      method: "POST",
      body: JSON.stringify({ action: "keep", driveId }),
    }),

  rollbackTestDrive: (id: string, driveId: string) =>
    request<{ drive: TestDriveView }>(`/api/library/public/${encodeURIComponent(id)}/test-drive`, {
      method: "POST",
      body: JSON.stringify({ action: "rollback", driveId }),
    }),

  listItems: (kind?: string) =>
    request<{ items: InstalledItem[]; notifications: LibraryNotification[] }>(
      `/api/library/items${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),

  addItem: (body: Record<string, unknown>) =>
    request<{ item: InstalledItem }>("/api/library/items", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteItem: (id: string) =>
    request<{ deleted: boolean }>(`/api/library/items/${encodeURIComponent(id)}`, { method: "DELETE" }),

  connectors: () => request<{ connectors: ConnectorEntry[] }>("/api/library/connectors"),

  addConnector: (connectorId: string, secrets?: Record<string, string>) =>
    request<{ item: InstalledItem }>("/api/library/connectors", {
      method: "POST",
      body: JSON.stringify({ connectorId, ...(secrets ? { secrets } : {}) }),
    }),
};
