'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FolderOpen,
  Folder,
  RefreshCw,
  Save,
  Radio,
  FilePlus2,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  Search,
  X,
  Terminal,
  Code2,
  FileText,
  Database,
  Layers,
  Sparkles,
  Download,
  GitCompare,
} from 'lucide-react';
import { authHeaders } from '@/lib/auth';
import DiffViewer from '@/components/DiffViewer';
import { buildUnifiedDiff } from '@/lib/parseDiff';

export interface FileTab {
  path: string;
  name: string;
  dirty?: boolean;
}

type Props = {
  sessionId: string | null;
  className?: string;
  pollMs?: number;
  initialPath?: string | null;
};

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (ext === 'ts' || ext === 'tsx') {
    return <span className="text-blue-400 font-mono text-[10px] font-bold">TS</span>;
  }
  if (ext === 'js' || ext === 'jsx') {
    return <span className="text-amber-400 font-mono text-[10px] font-bold">JS</span>;
  }
  if (ext === 'py') {
    return <span className="text-emerald-400 font-mono text-[10px] font-bold">PY</span>;
  }
  if (ext === 'json') {
    return <span className="text-yellow-400 font-mono text-[10px] font-bold">{'{}'}</span>;
  }
  if (ext === 'md') {
    return <FileText size={12} className="text-cyan-400 shrink-0" />;
  }
  if (ext === 'sql' || ext === 'db') {
    return <Database size={12} className="text-rose-400 shrink-0" />;
  }
  if (ext === 'css' || ext === 'scss') {
    return <span className="text-purple-400 font-mono text-[10px] font-bold">#</span>;
  }
  if (ext === 'sh' || ext === 'bash') {
    return <Terminal size={12} className="text-emerald-400 shrink-0" />;
  }
  return <Code2 size={12} className="text-zinc-400 shrink-0" />;
}

export function buildFileTree(files: string[]): Record<string, string[]> {
  const dirs: Record<string, string[]> = { '': [] };
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) {
      dirs[''].push(f);
      continue;
    }
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const next = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (!dirs[next]) dirs[next] = [];
      if (prefix === '') {
        if (!dirs[''].includes(parts[i] + '/')) dirs[''].push(parts[i] + '/');
      } else if (!dirs[prefix].includes(parts[i] + '/')) {
        dirs[prefix].push(parts[i] + '/');
      }
      prefix = next;
    }
    dirs[prefix].push(parts[parts.length - 1]);
  }
  for (const k of Object.keys(dirs)) {
    dirs[k].sort((a, b) => {
      const ad = a.endsWith('/') ? 0 : 1;
      const bd = b.endsWith('/') ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b);
    });
  }
  return dirs;
}

export default function VsCodeWorkspaceViewer({
  sessionId,
  className = '',
  pollMs = 2000,
  initialPath = null,
}: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [openTabs, setOpenTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [livePulse, setLivePulse] = useState(false);
  const [pulseMessage, setPulseMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': true, src: true, deliverables: true });
  const [filterQuery, setFilterQuery] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastHash = useRef<string>('');
  const dirty = content !== savedContent;

  const diffText = useMemo(() => {
    if (!activeTabPath || !dirty) return '';
    return buildUnifiedDiff(activeTabPath, savedContent, content);
  }, [activeTabPath, dirty, savedContent, content]);

  useEffect(() => {
    if (!dirty) setShowDiff(false);
  }, [dirty]);

  const refreshList = useCallback(async () => {
    if (!sessionId) {
      setFiles([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/tasks/workspace?sessionId=${encodeURIComponent(sessionId)}&heatmap=1`,
        { headers: authHeaders(), cache: 'no-store' }
      );
      const data = await res.json();
      if (!data.ok) return;
      const list = Array.isArray(data.files) ? data.files : [];
      setFiles(list);
      setWorkspace(String(data.workspace || ''));
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  const openFile = useCallback(
    async (rel: string, opts?: { silent?: boolean }) => {
      if (!sessionId) return;
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/tasks/workspace?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(rel)}`,
          { headers: authHeaders(), cache: 'no-store' }
        );
        const data = await res.json();
        if (!data.ok) {
          setError(data.error || 'Could not open file');
          return;
        }
        const next = String(data.content ?? '');
        const hash = `${rel}:${next.length}:${next.slice(0, 80)}`;

        // Add to tabs if not present
        setOpenTabs((prev) => {
          if (!prev.some((t) => t.path === rel)) {
            const name = rel.split('/').pop() || rel;
            return [...prev, { path: rel, name }];
          }
          return prev;
        });

        if (activeTabPath === rel && hash !== lastHash.current) {
          if (!dirty) {
            setContent(next);
            setSavedContent(next);
          }
          setLivePulse(true);
          setPulseMessage(`Live update in ${rel}`);
          setTimeout(() => setLivePulse(false), 2000);
        } else if (activeTabPath !== rel) {
          setActiveTabPath(rel);
          setContent(next);
          setSavedContent(next);
        }
        lastHash.current = hash;
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [sessionId, activeTabPath, dirty]
  );

  const closeTab = (tabPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs((prev) => {
      const filtered = prev.filter((t) => t.path !== tabPath);
      if (activeTabPath === tabPath) {
        const nextActive = filtered.length > 0 ? filtered[filtered.length - 1].path : null;
        if (nextActive) void openFile(nextActive);
        else {
          setActiveTabPath(null);
          setContent('');
          setSavedContent('');
        }
      }
      return filtered;
    });
  };

  const save = useCallback(async () => {
    if (!sessionId || !activeTabPath || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/tasks/workspace', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, path: activeTabPath, content }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || 'Save failed');
        return;
      }
      setSavedContent(content);
      setShowDiff(false);
      lastHash.current = `${activeTabPath}:${content.length}:${content.slice(0, 80)}`;
      await refreshList();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [sessionId, activeTabPath, dirty, content, refreshList]);

  const copyCode = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadFile = () => {
    if (!activeTabPath || !content) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeTabPath.split('/').pop() || 'download.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    refreshList();
    const id = setInterval(refreshList, pollMs);
    return () => clearInterval(id);
  }, [refreshList, pollMs]);

  useEffect(() => {
    if (!activeTabPath || !sessionId) return;
    const id = setInterval(() => openFile(activeTabPath, { silent: true }), pollMs);
    return () => clearInterval(id);
  }, [activeTabPath, sessionId, openFile, pollMs]);

  useEffect(() => {
    if (!activeTabPath && files.length) {
      void openFile(files[0]);
    }
  }, [files, activeTabPath, openFile]);

  useEffect(() => {
    if (initialPath && initialPath !== activeTabPath) {
      void openFile(initialPath);
    }
  }, [initialPath, activeTabPath, openFile]);

  const tree = useMemo(() => buildFileTree(files), [files]);

  const filteredTreeFiles = useMemo(() => {
    if (!filterQuery.trim()) return files;
    const q = filterQuery.toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q));
  }, [files, filterQuery]);

  const lines = useMemo(() => {
    return content.split('\n');
  }, [content]);

  const renderDir = (dirKey: string, depth: number) => {
    const entries = tree[dirKey] || [];
    return entries.map((name) => {
      const isDir = name.endsWith('/');
      const base = isDir ? name.slice(0, -1) : name;
      const full = dirKey ? `${dirKey}/${base}` : base;

      if (filterQuery.trim() && !isDir && !full.toLowerCase().includes(filterQuery.toLowerCase())) {
        return null;
      }

      if (isDir) {
        const open = expanded[full] ?? depth < 2;
        return (
          <div key={full}>
            <button
              type="button"
              onClick={() => setExpanded((e) => ({ ...e, [full]: !open }))}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.04] hover:text-white rounded transition"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              <ChevronRight
                size={11}
                className={`text-zinc-500 transition-transform ${open ? 'rotate-90 text-cyan-400' : ''}`}
              />
              {open ? (
                <FolderOpen size={13} className="text-amber-400/90 shrink-0" />
              ) : (
                <Folder size={13} className="text-amber-500/70 shrink-0" />
              )}
              <span className="truncate font-sans font-medium text-xs text-zinc-300">{base}</span>
            </button>
            {open && renderDir(full, depth + 1)}
          </div>
        );
      }

      const active = activeTabPath === full;
      return (
        <button
          key={full}
          type="button"
          onClick={() => openFile(full)}
          className={`w-full flex items-center justify-between gap-1.5 px-2 py-1 text-[11px] font-mono rounded transition ${
            active
              ? 'bg-cyan-500/10 text-cyan-200 border-l-2 border-cyan-400'
              : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
          }`}
          style={{ paddingLeft: 12 + depth * 12 }}
          title={full}
        >
          <div className="flex items-center gap-2 truncate min-w-0">
            {getFileIcon(name)}
            <span className="truncate">{name}</span>
          </div>
          {active && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />}
        </button>
      );
    });
  };

  if (!sessionId) {
    return (
      <div className={`rounded-2xl border border-white/[0.08] bg-[#0c0c14] p-12 text-center text-xs text-zinc-500 font-mono ${className}`}>
        <Code2 size={24} className="mx-auto mb-2 text-zinc-600" />
        Launch a mission to open the live VSCode codebase editor.
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border border-white/[0.08] bg-[#09090e] shadow-2xl flex flex-col overflow-hidden text-zinc-100 font-sans transition-all ${
        isFullscreen ? 'fixed inset-4 z-[999] rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)]' : 'min-h-[420px]'
      } ${className}`}
    >
      {/* Top VSCode Title Bar */}
      <div className="flex items-center justify-between gap-2 px-3.5 h-10 border-b border-white/[0.08] bg-[#0c0c14]">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-white font-mono">
            <span className="text-cyan-400">⚡</span>
            <span>Swarm Workspace Studio</span>
          </div>
          <span className="text-zinc-600">/</span>
          <div className="text-[11px] text-zinc-400 truncate font-mono max-w-[280px]">
            {workspace ? workspace.split('/').slice(-2).join('/') : sessionId} · {files.length} files
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {livePulse && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              <Radio size={10} className="animate-pulse" /> Live Pulse
            </span>
          )}

          <button
            type="button"
            onClick={copyCode}
            disabled={!content}
            className="p-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition"
            title="Copy file contents"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>

          <button
            type="button"
            onClick={downloadFile}
            disabled={!content}
            className="p-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition"
            title="Download file"
          >
            <Download size={12} />
          </button>

          <button
            type="button"
            onClick={() => refreshList()}
            className="p-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition"
            title="Refresh Explorer"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin text-cyan-400' : ''} />
          </button>

          {dirty && (
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                showDiff
                  ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                  : 'border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:text-white'
              }`}
              title="Toggle diff view"
            >
              <GitCompare size={11} />
              Diff
            </button>
          )}

          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-black disabled:opacity-40 transition shadow-xs"
          >
            <Save size={11} />
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>

          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition"
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Code Studio'}
          >
            {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>

      {/* Main Split: Explorer Sidebar + Editor */}
      <div className="flex flex-1 min-h-[360px] overflow-hidden">
        {/* Explorer Sidebar */}
        <aside className="w-[230px] border-r border-white/[0.08] bg-[#0c0c12] flex flex-col shrink-0">
          <div className="p-2 border-b border-white/[0.06] flex items-center gap-1.5">
            <Search size={11} className="text-zinc-500 shrink-0" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full bg-transparent text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
            />
            {filterQuery && (
              <button onClick={() => setFilterQuery('')} className="text-zinc-500 hover:text-white">
                <X size={10} />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
            {files.length === 0 ? (
              <div className="p-6 text-center text-xs text-zinc-600 font-mono space-y-2">
                <FilePlus2 size={20} className="mx-auto opacity-40 text-cyan-400" />
                <p>Waiting for agent deliverables...</p>
              </div>
            ) : (
              renderDir('', 0)
            )}
          </div>
        </aside>

        {/* Editor Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#09090d]">
          {/* Tabs Bar */}
          <div className="flex items-center gap-1 px-2 border-b border-white/[0.08] bg-[#0c0c14] overflow-x-auto no-scrollbar">
            {openTabs.map((tab) => {
              const active = tab.path === activeTabPath;
              return (
                <div
                  key={tab.path}
                  onClick={() => openFile(tab.path)}
                  className={`group flex items-center gap-2 px-3 py-2 text-xs font-mono border-t-2 cursor-pointer transition ${
                    active
                      ? 'border-cyan-400 bg-[#09090d] text-white font-medium'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02]'
                  }`}
                >
                  {getFileIcon(tab.name)}
                  <span className="truncate max-w-[140px]">{tab.name}</span>
                  {active && dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
                  <button
                    type="button"
                    onClick={(e) => closeTab(tab.path, e)}
                    className="opacity-0 group-hover:opacity-100 hover:text-rose-400 text-zinc-500 transition"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Breadcrumbs Path */}
          {activeTabPath && (
            <div className="px-4 py-1 border-b border-white/[0.04] bg-[#0a0a10] text-[11px] font-mono text-zinc-500 flex items-center gap-1.5">
              <span>workspace</span>
              {activeTabPath.split('/').map((part, i) => (
                <React.Fragment key={i}>
                  <ChevronRight size={10} className="text-zinc-600" />
                  <span className={i === activeTabPath.split('/').length - 1 ? 'text-zinc-300 font-medium' : ''}>
                    {part}
                  </span>
                </React.Fragment>
              ))}
              {dirty && <span className="ml-2 text-amber-400/90">● Unsaved</span>}
            </div>
          )}

          {error && (
            <div className="px-3 py-1.5 text-xs text-rose-300 bg-rose-950/40 border-b border-rose-500/20">
              {error}
            </div>
          )}

          {/* Code Editor or Diff View */}
          <div className="flex-1 flex min-h-0 overflow-hidden relative">
            {showDiff && dirty && activeTabPath && diffText ? (
              <DiffViewer
                filename={activeTabPath}
                diffText={diffText}
                streaming={false}
                className="flex-1 border-0 rounded-none min-h-0"
                onApprove={() => void save()}
                onReject={() => {
                  setContent(savedContent);
                  setShowDiff(false);
                }}
              />
            ) : (
              <>
                <div className="w-12 py-3 bg-[#0c0c12] border-r border-white/[0.06] select-none text-right pr-3 font-mono text-[11px] text-zinc-600 shrink-0 leading-[21px] overflow-hidden">
                  {lines.map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>

                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                  className="flex-1 w-full h-full resize-none bg-[#09090d] text-[12px] font-mono text-zinc-200 leading-[21px] p-3 focus:outline-none selection:bg-cyan-500/30 font-normal tracking-wide"
                  placeholder="Select a file from the explorer to view live agent edits..."
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
