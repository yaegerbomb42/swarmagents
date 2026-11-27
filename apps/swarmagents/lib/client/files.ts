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

/* ── Live file changes (l8) ────────────────────────────────────────────── *
 * The run stream announces every tool call and result; this section folds
 * those items into the file activity the FilesView renders live — which
 * files the agent just wrote, and whether a shell command just ran — so the
 * tree can light up while the run is still streaming instead of waiting for
 * run.finished. Pure and DOM-free, like the rest of this module.
 * ------------------------------------------------------------------------ */

import type { RunStreamItem } from "./useRunStream";

/** Tool names that write a workspace file, as the harness and providers spell them. */
const LIVE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "write",
  "edit",
  "create_file",
  "str_replace_editor",
  "apply_patch",
  "fs_write",
]);

/** Argument keys that can name the file a tool call touches. */
const LIVE_FILE_ARG_KEYS = ["file_path", "path", "file", "notebook_path"] as const;

/** Short tool name (`mcp__fs__write` → `write`). */
function liveShortToolName(name: string): string {
  return name.split("__").pop() ?? name;
}

function liveIsWriteTool(name: string): boolean {
  return LIVE_WRITE_TOOLS.has(name) || LIVE_WRITE_TOOLS.has(liveShortToolName(name));
}

function liveIsBashTool(name: string): boolean {
  const short = liveShortToolName(name);
  return short === "Bash" || short === "bash";
}

function livePayloadOf(item: RunStreamItem): Record<string, unknown> {
  const raw = asObject(item.data);
  if (!raw) return {};
  const nested = asObject(raw.data);
  return nested ? { ...nested, ...raw } : raw;
}

function liveFileArg(input: unknown): string | undefined {
  const record = asObject(input);
  if (!record) return undefined;
  for (const key of LIVE_FILE_ARG_KEYS) {
    const value = liveStr(record[key]);
    if (value) return value;
  }
  return undefined;
}

function liveStr(value: unknown): string | undefined {
  const text = asString(value);
  return text !== "" ? text : undefined;
}

/**
 * The new text a write call carries, for locating the changed lines in the
 * reloaded preview: Edit's `new_string`, MultiEdit's per-edit `new_string`s,
 * NotebookEdit's `new_source`. Write carries the whole file as `content`,
 * so it reports none — the preview falls back to diffing old vs new bytes.
 */
function liveNewTexts(name: string, input: unknown): string[] {
  const record = asObject(input);
  if (!record) return [];
  const short = liveShortToolName(name);
  if (short === "Edit") {
    const next = liveStr(record.new_string);
    return next === undefined ? [] : [next];
  }
  if (short === "MultiEdit") {
    const edits = record.edits;
    if (!Array.isArray(edits)) return [];
    const texts: string[] = [];
    for (const raw of edits) {
      const edit = asObject(raw);
      if (edit) {
        const next = liveStr(edit.new_string);
        if (next !== undefined) texts.push(next);
      }
    }
    return texts;
  }
  if (short === "NotebookEdit") {
    const next = liveStr(record.new_source);
    return next === undefined ? [] : [next];
  }
  return [];
}

/** One confirmed file write from the run stream. */
export interface FileEditEvent {
  /** Workspace-absolute path of the file the agent wrote. */
  path: string;
  /** Epoch ms of the tool.result that confirmed the write. */
  at: number;
  /** Short tool name (Write, Edit, MultiEdit, NotebookEdit, …). */
  tool: string;
  /** New text the call wrote, when it carried any (see liveNewTexts). */
  newTexts: string[];
  /** seq of the tool.result, so callers can tell what is new. */
  seq: number;
}

/** The file activity a run stream carries, folded to the small summary. */
export interface FileActivity {
  /** Confirmed writes, in stream order. */
  edits: FileEditEvent[];
  /** Epoch ms of the newest Bash tool.result, when the stream has one. */
  bashAt?: number;
  /** seq of that Bash result, so callers can tell what is new. */
  bashSeq?: number;
  /** seq of the newest event consumed. */
  seq: number;
}

interface LivePendingCall {
  id?: string;
  name: string;
  file?: string;
  newTexts: string[];
}

/**
 * Fold the run stream into its file activity. A tool.result pairs with its
 * tool.call by `id` when present, otherwise with the most recent still-open
 * call — the stream's natural round-trip order (same rule runTimeline uses).
 * Only successful results count: a failed write never touched the file, and
 * a blocked call is closed without an event. Paths outside the workspace are
 * skipped — the tree cannot show them.
 */
export function deriveFileActivity(items: readonly RunStreamItem[]): FileActivity {
  const edits: FileEditEvent[] = [];
  let bashAt: number | undefined;
  let bashSeq: number | undefined;
  let seq = 0;
  const pending: LivePendingCall[] = [];

  for (const item of items) {
    seq = Math.max(seq, item.seq);
    const payload = livePayloadOf(item);
    switch (item.kind) {
      case "run.created":
      case "run.queued":
      case "run.started":
        // A new run orphans the previous run's in-flight calls.
        pending.length = 0;
        break;
      case "tool.call": {
        const name = liveStr(payload.name) ?? "tool";
        const input = payload.input;
        pending.push({
          id: liveStr(payload.id),
          name,
          file: liveFileArg(input),
          newTexts: liveNewTexts(name, input),
        });
        break;
      }
      case "tool.result": {
        const ok = payload.ok !== false;
        const id = liveStr(payload.id);
        const index = id
          ? pending.findIndex((call) => call.id === id)
          : pending.length - 1;
        if (index < 0) break;
        const [call] = pending.splice(index, 1);
        if (!call || !ok) break;
        if (liveIsWriteTool(call.name) && call.file) {
          let path: string;
          try {
            path = normalizeWorkspacePath(call.file);
          } catch {
            break;
          }
          edits.push({
            path,
            at: item.ts,
            tool: liveShortToolName(call.name),
            newTexts: call.newTexts,
            seq: item.seq,
          });
        } else if (liveIsBashTool(call.name)) {
          bashAt = item.ts;
          bashSeq = item.seq;
        }
        break;
      }
      case "tool.blocked": {
        // The blocked call never ran: close the most recent open call with
        // that name (or the most recent open call) so a later result cannot
        // pair with it.
        const name = liveStr(payload.name);
        let index = pending.length - 1;
        if (name !== undefined) {
          for (let i = pending.length - 1; i >= 0; i -= 1) {
            if (pending[i]?.name === name || liveShortToolName(pending[i]?.name ?? "") === name) {
              index = i;
              break;
            }
          }
        }
        if (index >= 0) pending.splice(index, 1);
        break;
      }
      default:
        break;
    }
  }

  const activity: FileActivity = { edits, seq };
  if (bashAt !== undefined) activity.bashAt = bashAt;
  if (bashSeq !== undefined) activity.bashSeq = bashSeq;
  return activity;
}

/** A 1-based inclusive line span inside a file preview. */
export interface ChangedLineRange {
  startLine: number;
  endLine: number;
}

/**
 * Locate needle text inside content; the 1-based line span it occupies, or
 * null when the text is absent (or empty). The first occurrence wins — an
 * edit's new_string is expected to be unique in the file.
 */
export function locateTextRange(content: string, needle: string): ChangedLineRange | null {
  if (!needle) return null;
  const at = content.indexOf(needle);
  if (at < 0) return null;
  const before = content.slice(0, at);
  const startLine = before.split("\n").length;
  const endLine = startLine + needle.split("\n").length - 1;
  return { startLine, endLine };
}

/**
 * Diff old vs new content by common prefix/suffix lines; the changed span in
 * the NEW content, or null when the two are identical. A wholly new file
 * reports its whole span; an emptied file reports null (nothing to point at).
 */
export function changedLineRange(before: string, after: string): ChangedLineRange | null {
  if (before === after) return null;
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const startLine = prefix + 1;
  const endLine = newLines.length - suffix;
  if (startLine > endLine) return null;
  return { startLine, endLine };
}

/**
 * The line range to highlight for a reloaded preview: first try each new
 * text the edit carried (Edit/MultiEdit/NotebookEdit), else diff the old
 * bytes against the new ones (Write, or text that no longer matches).
 * Returns null when there is nothing to point at.
 */
export function highlightRangeForEdit(
  before: string | undefined,
  after: string,
  newTexts: readonly string[],
): ChangedLineRange | null {
  for (const text of newTexts) {
    const range = locateTextRange(after, text);
    if (range) return range;
  }
  if (before === undefined) return null;
  return changedLineRange(before, after);
}

/** How long a touched file keeps its emerald dot after its last write. */
export const TOUCHED_DOT_TTL_MS = 60_000;

/** One file the agent touched this run, with its latest write. */
export interface TouchedFile {
  path: string;
  at: number;
  tool: string;
  newTexts: string[];
}

/** "edited just now" / "edited 12s ago" — the rail's dot label. */
export function formatEditedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "edited just now";
  return `edited ${seconds}s ago`;
}

/** Drop touched files older than the dot TTL. */
export function pruneTouchedFiles(
  touched: readonly TouchedFile[],
  now: number,
): TouchedFile[] {
  return touched.filter((entry) => now - entry.at < TOUCHED_DOT_TTL_MS);
}

/**
 * Merge new edit events into the touched list: the newest write wins per
 * path, earlier entries keep their place. Returns a new array.
 */
export function mergeTouchedFiles(
  current: readonly TouchedFile[],
  edits: readonly FileEditEvent[],
): TouchedFile[] {
  const next = [...current];
  for (const edit of edits) {
    const entry: TouchedFile = {
      path: edit.path,
      at: edit.at,
      tool: edit.tool,
      newTexts: edit.newTexts,
    };
    const index = next.findIndex((existing) => existing.path === edit.path);
    if (index >= 0) next[index] = entry;
    else next.push(entry);
  }
  return next;
}

/** Clock behind the debouncer; injectable so tests drive it without timers. */
export interface DebounceClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const REAL_DEBOUNCE_CLOCK: DebounceClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Trailing-edge debounce with one slot: scheduling again before the timer
 * fires replaces the pending call, so a burst of writes refreshes once.
 * The clock is injectable (REAL_DEBOUNCE_CLOCK by default) so unit tests
 * can fire it deterministically.
 */
export class DebouncedTrigger {
  private pending: unknown = undefined;

  constructor(private readonly clock: DebounceClock = REAL_DEBOUNCE_CLOCK) {}

  /** Schedule `fn` after `ms`; replaces any pending call. */
  trigger(fn: () => void, ms: number): void {
    this.cancel();
    this.pending = this.clock.setTimeout(() => {
      this.pending = undefined;
      fn();
    }, ms);
  }

  /** Drop the pending call, if any. */
  cancel(): void {
    if (this.pending !== undefined) {
      this.clock.clearTimeout(this.pending);
      this.pending = undefined;
    }
  }

  /** Whether a call is currently scheduled. */
  get isPending(): boolean {
    return this.pending !== undefined;
  }
}
