'use client';

import React, { useState } from 'react';
import {
  Globe,
  MessageSquare,
  GitBranch,
  FilePlus,
  Brain,
  Database,
  Archive,
  GitCommit,
  FileEdit,
  Terminal,
  Search,
  FileText,
  Zap,
  ChevronDown,
  ChevronRight,
  Clock,
  Sparkles,
} from 'lucide-react';
import type { SandboxAction } from '@/lib/sandboxTypes';

interface SandboxActionLogProps {
  actions: any[];
  activeWorkspaceTab: 'browser' | 'editor' | 'terminal' | 'blackboard' | 'graph';
  onTabChange: (tab: 'browser' | 'editor' | 'terminal' | 'blackboard' | 'graph') => void;
  onParamEdit?: (actionId: string, key: string, value: string) => void;
  maxVisible?: number;
}

export default function SandboxActionLog({
  actions = [],
  activeWorkspaceTab,
  onTabChange,
  onParamEdit,
  maxVisible = 50,
}: SandboxActionLogProps) {
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [editFn, setEditFn] = useState('');
  const [editArgs, setEditArgs] = useState('');
  const [selectedActionId, setSelectedActionId] = useState<string | number | null>(null);
  const [showFileDiff, setShowFileDiff] = useState(true);

  const handleActionClick = (action: any) => {
    setSelectedActionId(action.id);
    const fn = (action.fn || action.type || '').toLowerCase();
    if (fn.includes('browser') || fn.includes('browse') || fn.includes('search')) {
      onTabChange('browser');
    } else if (fn.includes('shell') || fn.includes('exec') || fn.includes('command')) {
      onTabChange('terminal');
    } else if (fn.includes('create') || fn.includes('edit') || fn.includes('file') || fn.includes('commit')) {
      onTabChange('editor');
    } else if (fn.includes('think') || fn.includes('blackboard') || fn.includes('compress')) {
      onTabChange('blackboard');
    } else if (fn.includes('spawn') || fn.includes('communicat') || fn.includes('graph')) {
      onTabChange('graph');
    }
  };

  const startEdit = (action: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(action.id);
    setEditFn(action.fn || action.type || '');
    setEditArgs(action.args || action.label || '');
  };

  const saveEdit = (actionId: string | number) => {
    if (onParamEdit) {
      onParamEdit(String(actionId), editFn, editArgs);
    }
    setEditingId(null);
  };

  const visibleActions = (actions || []).slice(-maxVisible);
  const lastFileAction = [...(actions || [])].reverse().find((a: any) => a && a.filePath);
  const diffLineList: string[] =
    typeof lastFileAction?.diffLines === 'string' && lastFileAction.diffLines.trim()
      ? lastFileAction.diffLines.split('\n')
      : [];
  const plusCount = diffLineList.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const minusCount = diffLineList.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0F0F0F] font-mono text-[11px] p-4 select-none">
      <div className="flex items-center justify-between mb-3 text-[9px] text-[var(--fg-3)] uppercase tracking-wider">
        <span>Action Log</span>
        <span className="text-[#2a2a2a] lowercase tracking-normal">{visibleActions.length + 1} ops · live</span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 pr-1">
        {visibleActions.map((action: any) => {
          const isSelected = selectedActionId === action.id;
          const isEditing = editingId === action.id;
          const color = action.color || (action.type === 'use_browser' ? '#888' : action.type === 'spawn_subagent' ? '#a855f7' : '#00f5ff');

          return (
            <div key={action.id} className="relative">
              <button
                type="button"
                onClick={() => handleActionClick(action)}
                className={`group w-full flex items-center gap-3 text-left py-1.5 px-2.5 rounded-md transition-all ${
                  isSelected
                    ? 'bg-[#141414] border border-[#1e1e1e]'
                    : isEditing
                    ? 'bg-[#161616] border border-transparent'
                    : 'bg-transparent border border-transparent hover:bg-[#161616]'
                }`}
              >
                <span className="text-[10px] text-[var(--fg-3)] min-w-[46px] tabular-nums">
                  {typeof action.ts === 'string'
                    ? action.ts
                    : action.ts
                      ? new Date(action.ts).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })
                      : '—'}
                </span>
                <span
                  className="w-1 h-1 rounded-full shrink-0"
                  style={{ backgroundColor: isSelected ? '#00f5ff' : color }}
                />
                <span
                  className="text-[11px] leading-4 truncate flex-1"
                  style={{ color: isSelected ? '#fff' : color }}
                >
                  {action.fn || action.type}
                  <span className="opacity-70 ml-1">{action.args || action.label || ''}</span>
                </span>
                <span
                  onClick={(e) => startEdit(action, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-[#00f5ff] ml-2 shrink-0 cursor-pointer"
                >
                  · {isSelected ? 'active' : 'edit'}
                </span>
              </button>

              {/* Inline Action Editor Drawer */}
              {isEditing && (
                <div className="my-1.5 p-2.5 bg-[#0a0a0a] border border-[#1e1e1e] rounded-lg shadow-2xl animate-in fade-in duration-100">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editFn}
                      onChange={(e) => setEditFn(e.target.value)}
                      placeholder="function"
                      className="flex-[0.9] text-[11px] bg-[#121212] border border-[#1a1a1a] rounded px-2 py-1 text-zinc-200 outline-none focus:border-cyan-500/50"
                    />
                    <input
                      type="text"
                      value={editArgs}
                      onChange={(e) => setEditArgs(e.target.value)}
                      placeholder="args"
                      className="flex-[1.2] text-[11px] bg-[#121212] border border-[#1a1a1a] rounded px-2 py-1 text-zinc-400 outline-none focus:border-cyan-500/50"
                    />
                  </div>
                  <div className="flex justify-between items-center mt-2 text-[9px]">
                    <span className="text-[var(--fg-3)]">↵ save · esc cancel</span>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="text-[10px] text-zinc-500 bg-[#151515] border border-[#1a1a1a] rounded px-2 py-0.5"
                      >
                        cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdit(action.id)}
                        className="text-[10px] text-black bg-[#00f5ff] rounded px-2.5 py-0.5 font-medium"
                      >
                        save
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Latest real file edit (only when an action reported a path) */}
        {lastFileAction && (
        <div className="mt-2 rounded-lg border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
          <div
            onClick={() => {
              onTabChange('editor');
              setShowFileDiff(!showFileDiff);
            }}
            className="flex items-center justify-between px-3 py-2 bg-[#101010] hover:bg-[#151515] cursor-pointer transition-colors text-[11px]"
          >
            <div className="flex items-center gap-2.5 min-w-0 truncate">
              <span className="w-1 h-1 rounded-full bg-[#e5e5e5]" />
              <span className="text-zinc-300 truncate">
                <span className="text-[var(--fg-3)]">File edited:</span> {lastFileAction.filePath}
              </span>
            </div>
            {diffLineList.length > 0 && (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-emerald-500 text-[11px]">+{plusCount}</span>
                <span className="text-rose-500 text-[11px]">-{minusCount}</span>
                <span className="text-[11px] text-zinc-400 hover:text-cyan-400">
                  · {showFileDiff ? 'hide' : 'show'}
                </span>
              </div>
            )}
          </div>

          {showFileDiff && diffLineList.length > 0 && (
            <div className="bg-[#0F0F0F] border-t border-[#1a1a1a] font-mono text-[11px] select-text max-h-48 overflow-auto">
              {diffLineList.slice(0, 40).map((line, i) => {
                const add = line.startsWith('+') && !line.startsWith('+++');
                const del = line.startsWith('-') && !line.startsWith('---');
                return (
                  <div
                    key={i}
                    className={`px-3 py-0.5 truncate ${
                      add ? 'bg-emerald-500/5 text-emerald-300' : del ? 'bg-rose-500/5 text-rose-300' : 'text-zinc-400'
                    }`}
                  >
                    {line || ' '}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

