"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Binary,
  Check,
  ChevronLeft,
  ChevronRight,
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

interface FilesViewProps {
  /**
   * Monotonic token that changes when the current run emits run.finished, so
   * the listing and open preview re-read the workspace after the agent writes.
   */
  refreshToken?: number;
  /**
   * A workspace path to open (absolute, inside the workspace). The file is
   * selected and its folder is shown — used by the Codebase tab, which opens
   * a file of the map in the file browser.
   */
  openPath?: string;
}

type FileKind = "code" | "image" | "text" | "binary";

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
]);

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const TEXT_EXTENSIONS = new Set([
  "csv",
  "env",
  "ini",
  "json",
  "log",
  "md",
  "mdx",
  "rst",
  "text",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

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

function entryIcon(entry: WorkspaceEntry) {
  if (entry.type === "directory") {
    return <Folder className="h-3.5 w-3.5 shrink-0 text-cyan-400/80" />;
  }
  switch (fileKind(entry)) {
    case "code":
      return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" />;
    case "image":
      return <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />;
    case "text":
      return <FileText className="h-3.5 w-3.5 shrink-0 text-white/50" />;
    default:
      return <Binary className="h-3.5 w-3.5 shrink-0 text-amber-300/70" />;
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

export function FilesView({ refreshToken = 0, openPath }: FilesViewProps) {
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [listing, setListing] = useState<WorkspaceListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

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

  // Directory listing (also reloads when a run finishes or the user refreshes).
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchWorkspaceListing(path, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
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
  }, [path, refreshToken, reload]);

  // Open file preview (re-read on refresh so the agent's latest writes show).
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
  }, [selected, refreshToken, reload]);

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

  const openEntry = useCallback(
    (entry: WorkspaceEntry) => {
      if (entry.type === "directory") {
        navigate(joinWorkspacePath(path, entry.name));
        return;
      }
      setSelected(entry.path);
    },
    [navigate, path],
  );

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

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Toolbar: breadcrumb path + refresh */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#0f0f15] px-3 py-2">
        <button
          onClick={() => parent && navigate(parent)}
          disabled={!parent}
          title="Up one folder"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[11px] scrollbar-thin"
        >
          {crumbs.map((crumb, index) => {
            const isCurrent = index === crumbs.length - 1;
            return (
              <React.Fragment key={crumb.path}>
                {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-white/20" />}
                <button
                  onClick={() => navigate(crumb.path)}
                  disabled={isCurrent}
                  aria-current={isCurrent ? "page" : undefined}
                  title={crumb.path}
                  className={`shrink-0 rounded px-1 py-0.5 transition-colors ${
                    isCurrent
                      ? "cursor-default text-white/75"
                      : "text-cyan-300/70 hover:bg-white/10 hover:text-cyan-200"
                  }`}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
        {refreshToken > 0 && (
          <span className="shrink-0 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-mono text-emerald-300/80">
            synced
          </span>
        )}
        <button
          onClick={() => setReload((n) => n + 1)}
          title="Refresh"
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-mono text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Directory listing */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto border-r border-white/10 scrollbar-thin">
          {error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <AlertTriangle className="h-5 w-5 text-rose-400/70" />
              <div className="text-xs text-rose-300/90">{error}</div>
              <button
                onClick={() => setReload((n) => n + 1)}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
              >
                Try again
              </button>
            </div>
          ) : loading && !listing ? (
            <div className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-white/40">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading workspace…
            </div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center" data-testid="files-empty">
              <FolderOpen className="h-6 w-6 text-white/20" />
              <div className="text-xs text-white/50">This workspace is empty</div>
              <div className="max-w-[260px] text-[11px] leading-relaxed text-white/40">
                The workspace is the VM’s working directory. The first run fills it with project files.
              </div>
            </div>
          ) : (
            <>
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_64px_112px] items-center gap-2 border-b border-white/5 bg-[#0b0b10]/95 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white/30 backdrop-blur">
                <span>Name</span>
                <span className="text-right">Size</span>
                <span className="text-right">Modified</span>
              </div>
              <div className="p-1.5">
                {listing?.entries.map((entry) => {
                  const active = selected === entry.path;
                  return (
                    <button
                      key={entry.path}
                      onClick={() => openEntry(entry)}
                      className={`grid w-full grid-cols-[minmax(0,1fr)_64px_112px] items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-[11px] transition-colors ${
                        active
                          ? "bg-cyan-400/10 text-white ring-1 ring-inset ring-cyan-400/20"
                          : "text-white/70 hover:bg-white/[0.07]"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {entryIcon(entry)}
                        <span className="min-w-0 truncate">{entry.name}</span>
                      </span>
                      <span className="text-right text-[10px] text-white/30">
                        {entry.type === "directory" ? "—" : formatBytes(entry.size)}
                      </span>
                      <span className="text-right text-[10px] text-white/30">
                        {formatModified(entry.modifiedAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Preview pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
              <FileText className="h-5 w-5 text-white/20" />
              <div className="text-xs text-white/40">Select a file to preview it.</div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-white/10 bg-[#0f0f15] px-3 py-1.5">
                <FileText className="h-3.5 w-3.5 shrink-0 text-white/40" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70">
                  {selectedName}
                </span>
                {file && <span className="shrink-0 text-[10px] text-white/30">{formatBytes(file.size)}</span>}
                <a
                  href={workspaceFileDownloadUrl(selected)}
                  download
                  title="Download file"
                  aria-label="Download file"
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] text-white/50 transition hover:bg-white/10 hover:text-white"
                >
                  <Download className="h-3 w-3" />
                  <span>Download</span>
                </a>
                <button
                  onClick={copyContent}
                  disabled={!canCopy}
                  title="Copy file contents"
                  aria-label="Copy file contents"
                  className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-mono text-[10px] transition disabled:cursor-not-allowed disabled:opacity-30 ${
                    copied
                      ? "bg-emerald-400/10 text-emerald-300"
                      : "text-white/50 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
                <button
                  onClick={() => setSelected(undefined)}
                  title="Close preview"
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/40 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>

              {fileLoading ? (
                <div className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-white/40">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading file…
                </div>
              ) : fileError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                  <AlertTriangle className="h-5 w-5 text-rose-400/70" />
                  <div className="text-xs text-rose-300/90">{fileError}</div>
                </div>
              ) : file?.binary ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                  <AlertTriangle className="h-5 w-5 text-amber-400/70" />
                  <div className="text-xs text-white/60">{describeBinaryPreview(file.size)}</div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-white/75 scrollbar-thin">
                    {file?.content ?? ""}
                  </pre>
                  {file?.truncated && (
                    <div className="flex items-center gap-1.5 border-t border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-[10px] text-amber-200/80">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span>{describeTruncatedPreview(file.limit, file.size)}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
