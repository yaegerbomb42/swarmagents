/**
 * Client helpers for the workspace file browser.
 *
 * The UI never talks to the VM directly; it goes through
 * GET /api/runtime/vm/files. These helpers build the request URLs, keep paths
 * scoped to /workspace, and turn the API's error payloads into a typed
 * FileBrowserError the views can render.
 */

/** Root of the per-user persistent volume, mirrored from lib/vm/files. */
export const WORKSPACE_ROOT = "/workspace";

export type WorkspaceEntryType = "file" | "directory" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  size: number;
  modifiedAt?: number;
}

export interface WorkspaceListing {
  path: string;
  kind: "directory";
  root: string;
  parent: string | null;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFile {
  path: string;
  kind: "file";
  size: number;
  truncated: boolean;
  binary: boolean;
  /** Byte cap the API enforced for this read (1 MB). */
  limit: number;
  /** Present only for non-binary files. */
  content?: string;
}

/** One recently-modified workspace file, as the recent-scan reports it. */
export interface WorkspaceRecentFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  /** Inline-safe Content-Type for an <img> render. */
  contentType: string;
}

export interface WorkspaceRecentFiles {
  path: string;
  kind: "recent";
  /** Epoch ms the scan looked back from (now - windowMs). */
  since: number;
  windowMs: number;
  files: WorkspaceRecentFile[];
}

/** Categories the UI can render for a failed file request. */
export type FileBrowserErrorKind =
  | "invalid_path"
  | "forbidden"
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "unsupported"
  | "network"
  | "server"
  | "malformed";

export class FileBrowserError extends Error {
  readonly kind: FileBrowserErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(
    kind: FileBrowserErrorKind,
    message: string,
    extra?: { status?: number; code?: string },
  ) {
    super(message);
    this.name = "FileBrowserError";
    this.kind = kind;
    this.status = extra?.status;
    this.code = extra?.code;
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function pathError(kind: FileBrowserErrorKind, message: string): FileBrowserError {
  return new FileBrowserError(kind, message);
}

/**
 * Normalize a path to an absolute path inside /workspace.
 *
 * Relative paths are taken relative to /workspace, "." segments are dropped,
 * and ".." (or anything that escapes the workspace) is refused rather than
 * silently clamped.
 */
export function normalizeWorkspacePath(raw: string | null | undefined): string {
  const input = (raw ?? "").trim();
  if (!input) return WORKSPACE_ROOT;
  if (CONTROL_CHARS.test(input)) {
    throw pathError("invalid_path", "Path contains control characters.");
  }
  if (input.includes("\\")) {
    throw pathError("invalid_path", "Path contains a backslash.");
  }

  const absolute = input.startsWith("/") ? input : `${WORKSPACE_ROOT}/${input}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw pathError("forbidden", "Path traversal is not allowed.");
    }
    segments.push(segment);
  }

  const resolved = `/${segments.join("/")}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw pathError("forbidden", `Path must stay inside ${WORKSPACE_ROOT}.`);
  }
  return resolved;
}

/** Join a directory path and a child name into a normalized workspace path. */
export function joinWorkspacePath(dir: string, name: string): string {
  const base = normalizeWorkspacePath(dir);
  const child = (name ?? "").trim();
  if (!child) {
    throw pathError("invalid_path", "Entry name is empty.");
  }
  if (child.startsWith("/")) {
    return normalizeWorkspacePath(child);
  }
  return normalizeWorkspacePath(`${base}/${child}`);
}

/** Parent of a workspace path, or null when already at the workspace root. */
export function parentWorkspacePath(path: string): string | null {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === WORKSPACE_ROOT) return null;
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return null;
  return normalized.slice(0, idx);
}

export type FetchLike = typeof fetch;

export interface FilesRequestOptions {
  signal?: AbortSignal;
  /** Injectable fetch for tests and SSR-safe callers. */
  fetchImpl?: FetchLike;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function requestUrl(path: string, read: boolean): string {
  const params = new URLSearchParams({ path });
  if (read) params.set("read", "1");
  return `/api/runtime/vm/files?${params.toString()}`;
}

const STATUS_ERROR_KIND: Record<number, FileBrowserErrorKind> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  501: "unsupported",
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseListing(body: unknown): WorkspaceListing {
  const obj = asObject(body);
  if (!obj || obj.kind !== "directory" || !Array.isArray(obj.entries)) {
    throw new FileBrowserError("malformed", "The VM file API returned an unexpected directory listing.");
  }
  const entries: WorkspaceEntry[] = [];
  for (const raw of obj.entries) {
    const entry = asObject(raw);
    const name = asString(entry?.name);
    const path = asString(entry?.path);
    const type = asString(entry?.type);
    if (!entry || !name || !path || !type) {
      throw new FileBrowserError("malformed", "The VM file API returned an invalid entry.");
    }
    const size = asNumber(entry.size) ?? 0;
    const modifiedAt = asNumber(entry.modifiedAt);
    entries.push({
      name,
      path,
      type: type === "directory" ? "directory" : type === "file" ? "file" : "other",
      size,
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    });
  }
  return {
    path: asString(obj.path) ?? WORKSPACE_ROOT,
    kind: "directory",
    root: asString(obj.root) ?? WORKSPACE_ROOT,
    parent: obj.parent === null ? null : (asString(obj.parent) ?? null),
    entries,
  };
}

function parseFile(body: unknown): WorkspaceFile {
  const obj = asObject(body);
  if (!obj || obj.kind !== "file" || typeof obj.binary !== "boolean") {
    throw new FileBrowserError("malformed", "The VM file API returned an unexpected file payload.");
  }
  return {
    path: asString(obj.path) ?? "",
    kind: "file",
    size: asNumber(obj.size) ?? 0,
    truncated: obj.truncated === true,
    binary: obj.binary,
    limit: asNumber(obj.limit) ?? 0,
    ...(typeof obj.content === "string" ? { content: obj.content } : {}),
  };
}

async function requestJson(
  path: string,
  read: boolean,
  parse: (body: unknown) => WorkspaceListing | WorkspaceFile,
  options: FilesRequestOptions,
): Promise<WorkspaceListing | WorkspaceFile> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(requestUrl(path, read), { signal: options.signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new FileBrowserError("network", "Could not reach the VM file API.");
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const obj = asObject(body);
    const code = asString(obj?.code);
    const message =
      asString(obj?.error) ?? `The VM file API returned ${res.status}.`;
    const kind = STATUS_ERROR_KIND[res.status] ?? "server";
    throw new FileBrowserError(kind, message, { status: res.status, code });
  }

  return parse(body);
}

/** Fetch a directory listing from the VM file API. */
export async function fetchWorkspaceListing(
  path: string,
  options: FilesRequestOptions = {},
): Promise<WorkspaceListing> {
  return (await requestJson(path, false, parseListing, options)) as WorkspaceListing;
}

/** Fetch a capped text preview from the VM file API. */
export async function fetchWorkspaceFile(
  path: string,
  options: FilesRequestOptions = {},
): Promise<WorkspaceFile> {
  return (await requestJson(path, true, parseFile, options)) as WorkspaceFile;
}

function parseRecent(body: unknown): WorkspaceRecentFiles {
  const obj = asObject(body);
  if (!obj || obj.kind !== "recent" || !Array.isArray(obj.files)) {
    throw new FileBrowserError("malformed", "The VM file API returned an unexpected recent-files payload.");
  }
  const files: WorkspaceRecentFile[] = [];
  for (const raw of obj.files) {
    const file = asObject(raw);
    const name = asString(file?.name);
    const path = asString(file?.path);
    const modifiedAt = asNumber(file?.modifiedAt);
    if (!file || !name || !path || modifiedAt === undefined) {
      throw new FileBrowserError("malformed", "The VM file API returned an invalid recent file.");
    }
    files.push({
      name,
      path,
      size: asNumber(file.size) ?? 0,
      modifiedAt,
      contentType: asString(file.contentType) ?? "application/octet-stream",
    });
  }
  return {
    path: asString(obj.path) ?? WORKSPACE_ROOT,
    kind: "recent",
    since: asNumber(obj.since) ?? 0,
    windowMs: asNumber(obj.windowMs) ?? 0,
    files,
  };
}

/**
 * Fetch the workspace's recently-touched files (GET with recent=1; default
 * look-back 15 minutes, hard-capped at one hour, result capped at 25 files).
 */
export async function fetchRecentWorkspaceFiles(
  options: FilesRequestOptions & { path?: string; windowMs?: number; limit?: number } = {},
): Promise<WorkspaceRecentFiles> {
  const params = new URLSearchParams({ path: normalizeWorkspacePath(options.path) });
  params.set("recent", "1");
  if (options.windowMs !== undefined) params.set("windowMs", String(Math.floor(options.windowMs)));
  if (options.limit !== undefined) params.set("limit", String(Math.floor(options.limit)));
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`/api/runtime/vm/files?${params.toString()}`, { signal: options.signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new FileBrowserError("network", "Could not reach the VM file API.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const obj = asObject(body);
    const code = asString(obj?.code);
    const message = asString(obj?.error) ?? `The VM file API returned ${res.status}.`;
    const kind = STATUS_ERROR_KIND[res.status] ?? "server";
    throw new FileBrowserError(kind, message, { status: res.status, code });
  }
  return parseRecent(body);
}

/**
 * URL that downloads the raw file bytes (GET with download=1; the API
 * answers with Content-Disposition: attachment). Same-origin and owner-only
 * via the session cookie, so a plain link is enough to trigger a download.
 */
export function workspaceFileDownloadUrl(path: string): string {
  const params = new URLSearchParams({ path: normalizeWorkspacePath(path) });
  params.set("download", "1");
  return `/api/runtime/vm/files?${params.toString()}`;
}

/** Human-readable byte size (e.g. "1.5 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

/** Message suitable for an inline error state; unknown errors fall back safely. */
export function describeFilesError(err: unknown): string {
  if (err instanceof FileBrowserError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Could not load the VM filesystem.";
}

export { isAbortError };
