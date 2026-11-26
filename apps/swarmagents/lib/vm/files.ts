// Workspace-scoped file access for the VM file API.
//
// Everything a user can reach through /api/runtime/vm/files lives under
// /workspace (the container's persistent volume). Paths are resolved and
// rejected here — before any driver call — so a traversal attempt never
// reaches the VM at all.

/** Root of the per-user persistent volume inside the VM. */
export const WORKSPACE_ROOT = "/workspace";

/** Where chat attachments land inside the workspace. */
export const UPLOAD_DIR = `${WORKSPACE_ROOT}/uploads`;

/** Hard cap on files per upload request. */
export const MAX_UPLOAD_FILES = 10;

/** Hard cap on one file's size (10 MB). */
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;

/** Hard cap on the bytes returned for a single file read (1 MB). */
export const MAX_FILE_READ_BYTES = 1024 * 1024;

/**
 * Hard cap on the bytes returned for a single file download (10 MB, same as
 * the upload cap). Downloads serve whole files, never a truncated prefix, so
 * a file larger than this is refused with 413 instead of being cut short.
 */
export const MAX_FILE_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Content-Type by file extension for downloads; unknown types fall back to octet-stream. */
const DOWNLOAD_CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  log: "text/plain",
  mjs: "text/javascript",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  ts: "text/plain",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  zip: "application/zip",
};

/** Content-Type for a downloaded file, by extension, with a safe fallback. */
export function downloadContentType(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : "";
  return DOWNLOAD_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * A header-safe attachment filename for a workspace path: the basename with
 * quotes, backslashes and control characters stripped (they would break out
 * of the Content-Disposition header). Falls back to "download" when nothing
 * usable remains.
 */
export function downloadAttachmentFilename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const clean = base.replace(/["\\\u0000-\u001f\u007f]/g, "");
  return clean.length > 0 ? clean : "download";
}

/** Content-Disposition value for a file download (ASCII + RFC 5987 UTF-8 forms). */
export function downloadContentDisposition(path: string): string {
  const fileName = downloadAttachmentFilename(path);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Why a file operation failed, so routes can map it to a status code. */
export type VmFileErrorCode =
  | "not_found"
  | "not_a_directory"
  | "not_a_file"
  | "unsupported";

/** Typed error raised by the VM file helpers and the drivers. */
export class VmFileError extends Error {
  readonly code: VmFileErrorCode;
  constructor(code: VmFileErrorCode, message: string) {
    super(message);
    this.name = "VmFileError";
    this.code = code;
  }
}

/** Why a caller-supplied path was refused. */
export type VmPathErrorCode = "invalid_path" | "outside_workspace";

/** Typed error raised when a requested path is malformed or escapes the workspace. */
export class VmPathError extends Error {
  readonly code: VmPathErrorCode;
  constructor(code: VmPathErrorCode, message: string) {
    super(message);
    this.name = "VmPathError";
    this.code = code;
  }
}

/** Control characters (NUL included) are never valid in a VM path. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Resolve a caller-supplied path to an absolute path inside /workspace.
 *
 * - An empty path means the workspace root.
 * - A relative path is taken relative to /workspace ("notes.txt" ->
 *   "/workspace/notes.txt").
 * - ".." segments are rejected outright (no silent normalization), and any
 *   path outside /workspace is refused.
 *
 * @throws VmPathError when the path is malformed or leaves the workspace.
 */
export function resolveWorkspacePath(raw: string | null | undefined): string {
  const input = (raw ?? "").trim();
  if (!input) return WORKSPACE_ROOT;
  if (CONTROL_CHARS.test(input)) {
    throw new VmPathError("invalid_path", "Path contains control characters.");
  }
  if (input.includes("\\")) {
    throw new VmPathError("invalid_path", "Path contains a backslash.");
  }

  const absolute = input.startsWith("/") ? input : `${WORKSPACE_ROOT}/${input}`;
  const segments = absolute.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      throw new VmPathError("outside_workspace", "Path traversal is not allowed.");
    }
    out.push(segment);
  }
  if (out.length === 0) {
    throw new VmPathError("outside_workspace", `Path must stay inside ${WORKSPACE_ROOT}.`);
  }

  const resolved = `/${out.join("/")}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new VmPathError("outside_workspace", `Path must stay inside ${WORKSPACE_ROOT}.`);
  }
  return resolved;
}

/**
 * True when an absolute path is the workspace root or lives under it.
 * Lexical only — callers that touch the filesystem must still resolve
 * symlinks (see VmDriver.realpath) before trusting the result.
 */
export function isWorkspacePath(path: string): boolean {
  return path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`);
}

/**
 * Require a resolved (realpath'd) path to stay inside /workspace.
 * @throws VmPathError("outside_workspace") otherwise.
 */
export function assertWorkspaceContainment(resolved: string): string {
  if (!isWorkspacePath(resolved)) {
    throw new VmPathError(
      "outside_workspace",
      `Path resolves outside ${WORKSPACE_ROOT}.`,
    );
  }
  return resolved;
}

/** Parent of a resolved workspace path, or null for the workspace root. */
export function parentPath(path: string): string | null {
  if (path === WORKSPACE_ROOT) return null;
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return null;
  return path.slice(0, idx);
}

/**
 * Heuristic binary detection, mirroring git's rule of thumb: a NUL byte means
 * binary, and so does a high ratio of control characters.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  if (limit === 0) return false;
  let control = 0;
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / limit > 0.3;
}

// ---------------------------------------------------------------------------
// Recently-modified files (GET /api/runtime/vm/files?recent=1)
// ---------------------------------------------------------------------------

/** Hard cap on the files a recent-scan returns. */
export const MAX_RECENT_FILES = 25;
/** Hard cap on filesystem entries visited by one recent-scan walk. */
export const MAX_RECENT_WALK_ENTRIES = 2_000;
/** Hard cap on directory depth for the recent-scan walk. */
export const MAX_RECENT_WALK_DEPTH = 4;
/** Default look-back window for the recent scan (15 minutes of agent work). */
export const DEFAULT_RECENT_WINDOW_MS = 15 * 60_000;
/** Hard cap on the look-back window (one hour) — never a whole-workspace scan. */
export const MAX_RECENT_WINDOW_MS = 60 * 60_000;

/** One recently-modified workspace file as the recent-scan reports it. */
export interface VmRecentFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  /** Inline-safe Content-Type for an <img>/preview render. */
  contentType: string;
}

/**
 * Fold one directory level into a recent-scan. Pure: takes the already-listed
 * entries plus the running walk budget and returns the files that qualify
 * (modified inside the window) and the subdirectories still to visit, without
 * exceeding the entry budget. Directories carry no modifiedAt of their own.
 */
export function foldRecentDir(
  entries: VmDirEntryLike[],
  since: number,
  budget: { visited: number },
): { files: VmRecentFile[]; subdirs: string[] } {
  const files: VmRecentFile[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    budget.visited += 1;
    if (entry.type === "directory") {
      subdirs.push(entry.path);
      continue;
    }
    if (typeof entry.modifiedAt !== "number" || !Number.isFinite(entry.modifiedAt)) continue;
    if (entry.modifiedAt < since) continue;
    files.push({
      name: entry.name,
      path: entry.path,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
      contentType: downloadContentType(entry.name),
    });
  }
  return { files, subdirs };
}

/** Minimal entry shape the recent fold needs (subset of the driver's VmDirEntry). */
export interface VmDirEntryLike {
  name: string;
  path: string;
  type: string;
  size: number;
  modifiedAt?: number;
}

/** Sort candidates most-recent-first and keep the response cap. */
export function rankRecentFiles(files: VmRecentFile[], limit: number): VmRecentFile[] {
  return [...files].sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)).slice(0, Math.max(1, limit));
}
