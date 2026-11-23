"use client";

/**
 * FilesView — the workspace, not a file listing.
 *
 * Three ideas make it read as a workspace the agent is *working in*:
 *
 *   1. A tree rail on the left (folders you can open, with their contents
 *      nested one level), not a flat table of names and sizes. The rail keeps
 *      the folder you were in when you switch tabs.
 *   2. Presence. The file the agent last wrote is highlighted, re-read while
 *      the run is still streaming (not only at run.finished), and marked with
 *      a short amber flash the moment it changes (`changedPath`/`changedAt`
 *      from lib/client/presence). If nothing is open, the first file the agent
 *      touches is opened for you.
 *   3. A reading pane that keeps the file's identity: a small path header,
 *      a line-numbered monospace body, and an honest footer for truncated or
 *      binary files.
 *
 * Rendering a file is *chunked* (see `visibleSlice`): a 1 MB log is 20k lines
 * and painting all of them on every keystroke of a streaming run would stall
 * the terminal next door. Only the visible window (and a growing cap as the
 * user scrolls) is rendered.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Binary,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  Download,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  WORKSPACE_ROOT,
  describeFilesError,
  fetchWorkspaceFile,
  fetchWorkspaceListing,
  formatBytes,
  joinWorkspacePath,
  parentWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceListing,
  workspaceFileDownloadUrl,
} from "../../../lib/client/files";
import type { Presence } from "../../../lib/client/presence";
import { cn } from "../utils/cn";

interface FilesViewProps {
  /** Refresh the visible workspace while the agent is working. */
  readonly live?: boolean;
  /**
   * Monotonic token that changes when the current run emits run.finished, so
   * the listing and open preview re-read the workspace after the agent writes.
   */
  readonly refreshToken?: number;
  /**
   * A workspace path to open (absolute, inside the workspace). The file is
   * selected and its folder is shown — used by the Codebase tab, which opens
   * a file of the map in the file browser.
   */
  readonly openPath?: string;
  /**
   * The file the agent last wrote (from presence). It is highlighted in the
   * rail and re-read while the run is still streaming, so the view shows the
   * agent's work as it happens.
   */
  readonly changedPath?: string;
  /** Epoch ms of that write; a new value restarts the flash. */
  readonly changedAt?: number;
  /** The full presence summary, for the rail's "agent wrote this" marker. */
  readonly presence?: Presence;
}

type FileKind = "code" | "image" | "text" | "binary";

const CODE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "jsx",
  "kt", "php", "py", "rb", "rs", "scss", "sh", "sql", "svelte", "swift", "toml",
  "ts", "tsx", "vue",
]);

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

const TEXT_EXTENSIONS = new Set([
  "csv", "env", "ini", "json", "log", "md", "mdx", "rst", "text", "txt", "xml", "yaml", "yml",
]);

/** Lines rendered at once; the rest stream in as the reader scrolls. */
export const FILE_RENDER_CHUNK = 800;

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function fileKind(entry: WorkspaceEntry): FileKind {
  if (entry.type === "other") return "binary";
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "binary";
}

/** Small, consistent file-type mark: shape by kind, tint by kind. */
function entryIcon(entry: WorkspaceEntry, open = false) {
  if (entry.type === "directory") {
    return open ? (
      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-300/80" />
    ) : (
      <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300/70" />
    );
  }
  switch (fileKind(entry)) {
    case "code":
      return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-sky-300/80" />;
    case "image":
      return <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />;
    case "text":
      return <FileText className="h-3.5 w-3.5 shrink-0 text-white/50" />;
    default:
      return <Binary className="h-3.5 w-3.5 shrink-0 text-white/35" />;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatModified(modifiedAt?: number): string {
  if (!modifiedAt || !Number.isFinite(modifiedAt)) return "—";
  const date = new Date(modifiedAt);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

interface Crumb {
  label: string;
  path: string;
}

function buildCrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "workspace", path: WORKSPACE_ROOT }];
  if (path === WORKSPACE_ROOT || !path.startsWith(`${WORKSPACE_ROOT}/`)) return crumbs;
  const segments = path.slice(WORKSPACE_ROOT.length + 1).split("/").filter(Boolean);
  let current = WORKSPACE_ROOT;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

export function describeBinaryPreview(size: number): string {
  return `This file type can’t be previewed here. File size: ${formatBytes(size)}.`;
}

export function describeTruncatedPreview(limit: number, size: number): string {
  return `Only the first ${formatBytes(limit)} of ${formatBytes(size)} is shown. Download the file to see the rest.`;
}

/**
 * The lines to render for a body of text: everything up to `limit` lines, with
 * a note of how many are still collapsed. Pure, so the chunking policy is
 * unit-tested without a DOM.
 */
export function visibleSlice(content: string, limit: number): { lines: string[]; hidden: number } {
  const all = content.split("\n");
  // A trailing newline makes a final empty line that is not real content.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const shown = all.slice(0, limit);
  return { lines: shown, hidden: Math.max(0, all.length - shown.length) };
}

function countLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/* ── The tree rail ───────────────────────────────────────────────────────── */

interface DirState {
  loading: boolean;
  entries?: WorkspaceEntry[];
  error?: string;
}

/** Row highlight for a rail entry: selected wins, then just-changed, then updated while live. */
function entryRowClassName(isSelected: boolean, isChanged: boolean, isUpdated: boolean): string {
  if (isSelected) return "bg-sky-400/10 text-white ring-1 ring-inset ring-sky-400/25";
  if (isChanged) return "bg-amber-400/[0.08] text-amber-100/90";
  if (isUpdated) return "bg-emerald-400/10 text-emerald-200";
  return "text-white/70 hover:bg-white/[0.06]";
}

function RowChevron({ isDir, isOpen }: { readonly isDir: boolean; readonly isOpen: boolean }) {
  if (!isDir) return null;
  return isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />;
}

/** The badges after a rail entry's name: updated, just-changed, and the folder affordance. */
function RowBadges({
  isDir,
  isUpdated,
  isChanged,
}: {
  readonly isDir: boolean;
  readonly isUpdated: boolean;
  readonly isChanged: boolean;
}) {
  return (
    <>
      {isUpdated && <span className="shrink-0 text-[10px] text-emerald-300">Updated</span>}
      {isChanged && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300"
          title="The agent wrote this file"
          aria-label="Just changed by the agent"
        />
      )}
      {isDir && (
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-white/25 opacity-0 transition-opacity group-hover:opacity-100">
          open
        </span>
      )}
    </>
  );
}

/** An open folder's children in the rail: loading, error, empty, or the nested rows. */
function DirChildren({
  isOpen,
  dirState,
  depth,
  renderEntry,
}: {
  readonly isOpen: boolean;
  readonly dirState?: DirState;
  readonly depth: number;
  readonly renderEntry: (entry: WorkspaceEntry, depth: number) => React.ReactNode;
}) {
  if (!isOpen) return null;
  if (dirState?.loading) {
    return (
      <div className="ml-2 border-l border-white/5 pl-1">
        <div className="flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] text-white/30">
          <Loader2 className="h-3 w-3 animate-spin" /> reading…
        </div>
      </div>
    );
  }
  if (dirState?.error) {
    return (
      <div className="ml-2 border-l border-white/5 pl-1">
        <div className="px-2 py-1 font-mono text-[10px] text-rose-300/70">{dirState.error}</div>
      </div>
    );
  }
  if (dirState?.entries?.length === 0) {
    return (
      <div className="ml-2 border-l border-white/5 pl-1">
        <div className="px-2 py-1 font-mono text-[10px] text-white/25">empty</div>
      </div>
    );
  }
  return (
    <div className="ml-2 border-l border-white/5 pl-1">
      {dirState?.entries?.map((child) => renderEntry(child, depth + 1))}
    </div>
  );
}

/**
 * The rail: the current folder's children, with a folder's contents revealed
 * inline when it is opened. Only expanded folders are listed (one request
 * each), and the expanded set is kept while the view is hidden, so returning
 * to the tab finds the tree as it was left.
 */
function WorkspaceRail({
  path,
  entries,
  loading,
  error,
  selected,
  changedPath,
  changed,
  onOpenFile,
  onOpenFolder,
  onRetry,
}: {
  readonly path: string;
  readonly entries?: WorkspaceEntry[];
  readonly loading: boolean;
  readonly error?: string;
  readonly selected?: string;
  readonly changedPath?: string;
  /** Entries that changed between polls while the run is live. */
  readonly changed?: string[];
  readonly onOpenFile: (entry: WorkspaceEntry) => void;
  readonly onOpenFolder: (entry: WorkspaceEntry) => void;
  readonly onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dirs, setDirs] = useState<Record<string, DirState>>({});

  const toggle = useCallback(
    (entry: WorkspaceEntry) => {
      const isOpen = expanded[entry.path];
      setExpanded((current) => ({ ...current, [entry.path]: !isOpen }));
      if (isOpen || dirs[entry.path]) return;
      setDirs((current) => ({ ...current, [entry.path]: { loading: true } }));
      fetchWorkspaceListing(entry.path)
        .then((data) => {
          setDirs((current) => ({ ...current, [entry.path]: { loading: false, entries: data.entries } }));
        })
        .catch((err) => {
          setDirs((current) => ({
            ...current,
            [entry.path]: { loading: false, error: describeFilesError(err) },
          }));
        });
    },
    [dirs, expanded],
  );

  const sorted = useMemo(() => {
    if (!entries) return [];
    // Folders first, then files; alphabetical within each, like a tree view.
    return [...entries].sort((a, b) => {
      const dir = Number(b.type === "directory") - Number(a.type === "directory");
      return dir !== 0 ? dir : a.name.localeCompare(b.name);
    });
  }, [entries]);

  const renderEntry = (entry: WorkspaceEntry, depth: number): React.ReactNode => {
    const isDir = entry.type === "directory";
    const isOpen = Boolean(expanded[entry.path]);
    const isSelected = selected === entry.path;
    const isChanged = changedPath === entry.path;
    const isUpdated = !isChanged && (changed?.includes(entry.path) ?? false);
    const dirState = dirs[entry.path];
    return (
      <div key={entry.path}>
        <button
          type="button"
          onClick={() => (isDir ? toggle(entry) : onOpenFile(entry))}
          onDoubleClick={() => isDir && onOpenFolder(entry)}
          title={entry.path}
          style={{ paddingLeft: 6 + depth * 12 }}
          data-testid={isChanged ? "files-changed-entry" : undefined}
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left font-mono text-[11px] transition-colors",
            entryRowClassName(isSelected, isChanged, isUpdated),
          )}
        >
          <span className="flex h-3 w-3 shrink-0 items-center justify-center text-white/30">
            <RowChevron isDir={isDir} isOpen={isOpen} />
          </span>
          {entryIcon(entry, isOpen)}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          <RowBadges isDir={isDir} isUpdated={isUpdated} isChanged={isChanged} />
        </button>
        {isDir && (
          <DirChildren isOpen={isOpen} dirState={dirState} depth={depth} renderEntry={renderEntry} />
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 w-[240px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0a0a0e]">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-white/[0.07] px-2.5 font-mono text-[10px] uppercase tracking-wider text-white/35">
        <Folder className="h-3 w-3 text-amber-300/70" />
        Workspace
        {entries && <span className="ml-auto tabular-nums text-white/25">{entries.length}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        {error ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <AlertTriangle className="h-4 w-4 text-rose-400/70" />
            <div className="font-mono text-[10px] text-rose-300/90">{error}</div>
            <button
              type="button"
              onClick={onRetry}
              className="rounded border border-white/10 px-2 py-0.5 font-mono text-[10px] text-white/60 hover:bg-white/10 hover:text-white"
            >
              Try again
            </button>
          </div>
        ) : loading && sorted.length === 0 ? (
          <div className="flex items-center gap-1.5 px-2 py-2 font-mono text-[10px] text-white/35">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading workspace…
          </div>
        ) : sorted.length === 0 ? (
          <div className="px-2 py-3 font-mono text-[10px] leading-relaxed text-white/30" data-testid="files-empty">
            This workspace is empty.
            <br />
            The first run fills it with project files.
          </div>
        ) : (
          sorted.map((entry) => renderEntry(entry, 0))
        )}
      </div>
    </div>
  );
}

/* ── The reading pane ────────────────────────────────────────────────────── */

function CodeBody({ content }: { readonly content: string }) {
  const [limit, setLimit] = useState(FILE_RENDER_CHUNK);
  const { lines, hidden } = useMemo(() => visibleSlice(content, limit), [content, limit]);
  // A new file starts at the first chunk again.
  const firstLine = useRef<string>("");
  useEffect(() => {
    if (firstLine.current !== content.slice(0, 64)) {
      firstLine.current = content.slice(0, 64);
      setLimit(FILE_RENDER_CHUNK);
    }
  }, [content]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 font-mono text-[11px] leading-[1.55]">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="w-10 select-none border-r border-white/[0.05] pr-2 text-right align-top text-white/20">
                  {index + 1}
                </td>
                <td className="whitespace-pre-wrap break-words pl-3 pr-4 align-top text-white/80">{line || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setLimit((current) => current + FILE_RENDER_CHUNK * 2)}
          className="shrink-0 border-t border-white/[0.06] bg-black/30 px-3 py-1.5 font-mono text-[10px] text-sky-300/80 transition-colors hover:bg-sky-400/10"
        >
          Show more · {hidden} more lines
        </button>
      )}
    </div>
  );
}

/* ── The view ────────────────────────────────────────────────────────────── */

/** Compare snapshots only within the same directory; a first listing is not a change. */
export function changedWorkspaceEntries(previous: WorkspaceListing | undefined, next: WorkspaceListing): string[] {
  if (!previous || previous.path !== next.path) return [];
  const old = new Map(previous.entries.map((entry) => [entry.path, entry]));
  return next.entries.filter((entry) => {
    const before = old.get(entry.path);
    return (
      before?.modifiedAt !== entry.modifiedAt || before?.size !== entry.size || before?.type !== entry.type
    );
  }).map((entry) => entry.path);
}

/** The body of the reading pane: loading, error, binary, or the file text. */
function PreviewBody({
  file,
  fileLoading,
  fileError,
}: {
  readonly file?: WorkspaceFile;
  readonly fileLoading: boolean;
  readonly fileError?: string;
}) {
  if (fileLoading && !file) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-white/40">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading file…
      </div>
    );
  }
  if (fileError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle className="h-5 w-5 text-rose-400/70" />
        <div className="text-xs text-rose-300/90">{fileError}</div>
      </div>
    );
  }
  if (file?.binary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400/70" />
        <div className="text-xs text-white/60">{describeBinaryPreview(file.size)}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodeBody content={file?.content ?? ""} />
      {file?.truncated && (
        <div className="flex items-center gap-1.5 border-t border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-[10px] text-amber-200/80">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>{describeTruncatedPreview(file.limit, file.size)}</span>
        </div>
      )}
    </div>
  );
}

/** The open file: identity header (name, size, copy, download, close) above its body. */
function FilePreview({
  selected,
  selectedName,
  isChangedOpen,
  changedFlashKey,
  file,
  fileLoading,
  fileError,
  canCopy,
  copied,
  onCopy,
  onClose,
}: {
  readonly selected: string;
  readonly selectedName?: string;
  readonly isChangedOpen: boolean;
  readonly changedFlashKey: string;
  readonly file?: WorkspaceFile;
  readonly fileLoading: boolean;
  readonly fileError?: string;
  readonly canCopy: boolean;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onClose: () => void;
}) {
  return (
    <>
      <div
        key={isChangedOpen ? changedFlashKey : undefined}
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.07] bg-[#0d0d11] px-2.5",
          isChangedOpen && "sa-changed-flash",
        )}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-white/40" />
        <span className="min-w-0 shrink truncate font-mono text-[11px] text-white/70" title={selected}>
          {selectedName}
        </span>
        {isChangedOpen && (
          <span className="hidden shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-300 sm:inline">
            just changed
          </span>
        )}
        {file && (
          <span className="shrink-0 font-mono text-[10px] text-white/30">
            {formatBytes(file.size)}
            {file.content !== undefined && ` · ${countLines(file.content)} lines`}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <a
            href={workspaceFileDownloadUrl(selected)}
            download
            title="Download file"
            aria-label="Download file"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Download className="h-3 w-3" />
          </a>
          <button
            type="button"
            onClick={onCopy}
            disabled={!canCopy}
            title="Copy file contents"
            aria-label="Copy file contents"
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-30",
              copied ? "bg-emerald-400/10 text-emerald-300" : "text-white/50 hover:bg-white/10 hover:text-white",
            )}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close preview"
            aria-label="Close preview"
            className="grid h-5 w-5 place-items-center rounded text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>

      <PreviewBody file={file} fileLoading={fileLoading} fileError={fileError} />
    </>
  );
}

export function FilesView({ refreshToken = 0, openPath, changedPath, changedAt, presence, live = false }: FilesViewProps) {
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [listing, setListing] = useState<WorkspaceListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const previousListing = useRef<WorkspaceListing | undefined>(undefined);
  const [changed, setChanged] = useState<string[]>([]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setReload((n) => n + 1), 3000);
    return () => window.clearInterval(timer);
  }, [live]);

  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<WorkspaceFile>();
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const [copied, setCopied] = useState(false);

  // A file picked elsewhere (the Codebase treemap) opens here: show its
  // folder and select it.
  useEffect(() => {
    if (!openPath) return;
    if (!openPath.startsWith(`${WORKSPACE_ROOT}/`)) return;
    const dir = parentWorkspacePath(openPath);
    if (dir) setPath(dir);
    setSelected(openPath);
  }, [openPath]);

  // Presence: follow the agent's file. The first write of a run opens the
  // file; later writes re-read it in place if it is the open one. The agent
  // should never work invisibly.
  const lastFollowed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!changedPath || !changedPath.startsWith(`${WORKSPACE_ROOT}/`)) return;
    if (lastFollowed.current === `${changedPath}@${changedAt ?? 0}`) return;
    lastFollowed.current = `${changedPath}@${changedAt ?? 0}`;
    const dir = parentWorkspacePath(changedPath);
    if (dir) setPath(dir);
    setSelected(changedPath);
  }, [changedPath, changedAt]);

  // Directory listing (also reloads when a run finishes, the agent writes, or
  // the user refreshes).
  useEffect(() => {
    const ctrl = new AbortController();
    // Stale-while-revalidate: a refresh (a streaming run finishes a tool, the
    // user hits refresh) must never blank the tree the user is reading.
    setLoading(true);
    setError(undefined);
    fetchWorkspaceListing(path, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        const updates = changedWorkspaceEntries(previousListing.current, data);
        if (updates.length) setChanged(updates);
        else if (previousListing.current?.path !== data.path) setChanged([]);
        previousListing.current = data;
        setListing(data);
      })
      .catch((err) => {
        if (isAbort(err) || ctrl.signal.aborted) return;
        setError(describeFilesError(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, refreshToken, reload, changedAt]);

  // Open file preview (re-read on refresh, and on the agent's write, so the
  // latest bytes show while the run is still streaming).
  useEffect(() => {
    if (!selected) {
      setFile(undefined);
      setFileError(undefined);
      setFileLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setFileLoading(true);
    setFileError(undefined);
    fetchWorkspaceFile(selected, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setFile(data);
      })
      .catch((err) => {
        if (isAbort(err) || ctrl.signal.aborted) return;
        setFile(undefined);
        setFileError(describeFilesError(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setFileLoading(false);
      });
    return () => ctrl.abort();
  }, [selected, refreshToken, reload, changedAt]);

  useEffect(() => {
    setCopied(false);
  }, [selected]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const navigate = useCallback((next: string) => {
    setPath(next);
    setSelected(undefined);
    setFile(undefined);
    setFileError(undefined);
  }, []);

  const openEntry = useCallback((entry: WorkspaceEntry) => {
    if (entry.type === "directory") {
      // A single click on a folder name in the rail expands it (rail owns
      // that); the row's "open" affordance navigates into it.
      navigate(entry.path);
      return;
    }
    setSelected(entry.path);
  }, [navigate]);

  const copyContent = useCallback(async () => {
    if (!file || file.binary || file.content === undefined) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [file]);

  const parent = parentWorkspacePath(path);
  const crumbs = buildCrumbs(path);
  const selectedName = selected ? selected.slice(selected.lastIndexOf("/") + 1) : undefined;
  const canCopy = Boolean(file && !file.binary && !fileLoading && !fileError && file.content !== undefined);
  const isChangedOpen = Boolean(selected && selected === changedPath);
  const changedFlashKey = `${changedPath ?? ""}:${changedAt ?? 0}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-view">
      {/* Path bar: the one piece of chrome inside the view, and it is the
          workspace's own -- a breadcrumb, not a toolbar. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-white/[0.07] bg-[#0d0d11] px-2.5">
        <button
          type="button"
          onClick={() => parent && navigate(parent)}
          disabled={!parent}
          title="Up one folder"
          aria-label="Up one folder"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[11px] scrollbar-thin">
          {crumbs.map((crumb, index) => {
            const isCurrent = index === crumbs.length - 1;
            return (
              <React.Fragment key={crumb.path}>
                {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-white/20" />}
                <button
                  type="button"
                  onClick={() => navigate(crumb.path)}
                  disabled={isCurrent}
                  aria-current={isCurrent ? "page" : undefined}
                  title={crumb.path}
                  className={cn(
                    "shrink-0 rounded px-1 py-0.5 transition-colors",
                    isCurrent ? "cursor-default text-white/75" : "text-sky-300/70 hover:bg-white/10 hover:text-sky-200",
                  )}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
        {presence?.runState === "working" && (
          <span className="hidden shrink-0 items-center gap-1 font-mono text-[10px] text-amber-300/80 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300 sa-dot-live" />
            agent writing
          </span>
        )}
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          title="Refresh"
          aria-label="Refresh workspace"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <WorkspaceRail
          path={path}
          entries={listing?.entries}
          loading={loading}
          error={error}
          selected={selected}
          changedPath={changedPath}
          changed={changed}
          onOpenFile={openEntry}
          onOpenFolder={openEntry}
          onRetry={() => setReload((n) => n + 1)}
        />

        {/* Reading pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <FolderOpen className="h-5 w-5 text-white/20" />
              <div className="text-xs text-white/45">Pick a file to read it here.</div>
              <div className="max-w-[280px] text-[11px] leading-relaxed text-white/30">
                The agent&apos;s work shows up here as it happens — the file it writes is opened and highlighted
                automatically.
              </div>
            </div>
          ) : (
            <FilePreview
              selected={selected}
              selectedName={selectedName}
              isChangedOpen={isChangedOpen}
              changedFlashKey={changedFlashKey}
              file={file}
              fileLoading={fileLoading}
              fileError={fileError}
              canCopy={canCopy}
              copied={copied}
              onCopy={copyContent}
              onClose={() => setSelected(undefined)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
