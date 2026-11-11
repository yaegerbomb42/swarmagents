'use client';

import React, { useState, useEffect } from 'react';
import {
  Globe,
  FileCode,
  Brain,
  GitBranch,
  Play,
  Pause,
  Maximize2,
  Minimize2,
  RefreshCw,
  Cpu,
  Clock,
  Sparkles,
  Zap,
  Edit2,
  Check,
} from 'lucide-react';
import type { AgentSandbox } from '@/lib/sandboxTypes';
import StatusDot from '@/components/status/StatusDot';
import { toCanonical } from '@/lib/status';
import { AGENT_ROLES, getAgentRoleById, TIER_BADGE_CLASS, formatRoleLabel } from '@/lib/agentRoles';
import SandboxActionLog from './SandboxActionLog';
import SandboxBrowserPane from './SandboxBrowserPane';
import SandboxEditorPane from './SandboxEditorPane';
import SandboxBlackboardPane from './SandboxBlackboardPane';
import SandboxGraphPane from './SandboxGraphPane';
import SandboxMissionTerminal from './SandboxMissionTerminal';

type WorkspaceTab = 'browser' | 'editor' | 'terminal' | 'blackboard' | 'graph';

interface UnifiedAgentSandboxProps {
  sandbox: AgentSandbox;
  onUpdate?: (patch: Partial<AgentSandbox>) => void;
  compact?: boolean;
  className?: string;
  /** Side-by-side gutter diff for fleet patch review. */
  fleetReview?: boolean;
  sessionId?: string | null;
}

const ARCHETYPE_IDS = AGENT_ROLES.map((r) => r.id);

function roleBadgeClass(roleId: string): string {
  const role = getAgentRoleById(roleId);
  if (!role) return 'border-zinc-500/50 bg-zinc-500/10 text-zinc-400';
  return TIER_BADGE_CLASS[role.model_tier];
}

export default function UnifiedAgentSandbox({
  sandbox,
  onUpdate,
  compact = false,
  className = '',
  fleetReview = false,
  sessionId = null,
}: UnifiedAgentSandboxProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('browser');
  const [isEditingId, setIsEditingId] = useState(false);
  const [agentIdInput, setAgentIdInput] = useState(sandbox.label || sandbox.agentId || sandbox.id);
  const [isPaused, setIsPaused] = useState(sandbox.status === 'paused' || Boolean(sandbox.paused));
  const [rpmLimit, setRpmLimit] = useState(sandbox.rpmLimit || 60);
  const [tpmLimit, setTpmLimit] = useState(sandbox.tpmLimit || 120000);
  const [now, setNow] = useState(() => Date.now());

  // Elapsed time is derived from the real start timestamp only; no start → "—".
  const isLive = sandbox.status === 'running' && !isPaused;
  useEffect(() => {
    if (!isLive || !sandbox.startedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isLive, sandbox.startedAt]);
  const activeSeconds =
    typeof sandbox.activeTimeMs === 'number'
      ? Math.floor(sandbox.activeTimeMs / 1000)
      : sandbox.startedAt
        ? Math.max(0, Math.floor((now - sandbox.startedAt) / 1000))
        : null;
  const canonicalStatus = isPaused ? 'paused' : toCanonical(sandbox.status);

  const fmtNum = (n?: number) =>
    typeof n === 'number' && Number.isFinite(n) ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)) : '—';

  // Format HH:MM:SS
  const formatTime = (totalSec: number) => {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map((v) => v.toString().padStart(2, '0')).join(':');
  };

  const currentArchetype = sandbox.archetype || sandbox.agentClass || 'implementer';

  const cycleArchetype = () => {
    const idx = ARCHETYPE_IDS.indexOf(currentArchetype);
    const nextIdx = (idx >= 0 ? idx + 1 : 0) % ARCHETYPE_IDS.length;
    const nextArchetype = ARCHETYPE_IDS[nextIdx];
    onUpdate?.({ archetype: nextArchetype });
  };

  const togglePause = () => {
    const next = !isPaused;
    setIsPaused(next);
    onUpdate?.({ paused: next, status: next ? 'paused' : 'running' });
  };

  const currentModel = sandbox.model || '—';

  return (
    <div
      className={`flex flex-col bg-[#0F0F0F] border border-[#1a1a1a] rounded-[16px] overflow-hidden shadow-[inset_0_1px_0_rgba(0,245,255,0.12),0_0_0_1px_rgba(0,0,0,1),0_8px_40px_rgba(0,0,0,0.6)] relative transition-all font-mono select-none ${
        sandbox.focused ? 'border-cyan-500/60 shadow-[0_0_25px_rgba(0,245,255,0.25)]' : ''
      } ${className}`}
    >
      {/* Top Subtle Cyan Glow Line */}
      <div className="absolute top-0 left-[12%] right-[12%] h-[1px] bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent pointer-events-none" />

      {/* Header */}
      <div className="p-7 pb-0">
        <div className="flex items-center justify-between">
          {/* Left Archetype & Active Pulse */}
          <div className="flex items-center gap-2.5">
            <StatusDot status={canonicalStatus} size={7} />
            <button
              type="button"
              onClick={cycleArchetype}
              className="text-[11px] uppercase tracking-[0.14em] text-white hover:text-cyan-400 transition-colors"
              title="Click to cycle role"
            >
              {formatRoleLabel(currentArchetype)}
            </button>
          </div>

          {/* Right Model Badge */}
          <div
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-cyan-400/[0.05] border border-cyan-400/20 hover:border-cyan-400/40 transition-colors text-[10px] text-zinc-400"
            title={`Bound Model: ${currentModel}`}
          >
            <span className="w-1 h-1 rounded-full bg-[#00f5ff]" />
            <span className="truncate max-w-[120px]">{currentModel}</span>
          </div>
        </div>

        {/* Agent ID and Active/Paused State */}
        <div className="mt-4 flex items-baseline gap-3">
          {isEditingId ? (
            <input
              type="text"
              value={agentIdInput}
              onChange={(e) => setAgentIdInput(e.target.value)}
              onBlur={() => {
                setIsEditingId(false);
                onUpdate?.({ label: agentIdInput });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setIsEditingId(false);
                  onUpdate?.({ label: agentIdInput });
                }
              }}
              autoFocus
              className="text-[11px] text-white bg-[#121212] border border-cyan-400/40 rounded px-2 py-0.5 outline-none w-36 shadow-[0_0_0_3px_rgba(0,245,255,0.08)]"
            />
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingId(true)}
              className="text-[11px] text-white hover:text-cyan-400 transition-colors tracking-wide"
              title="Click to edit name"
            >
              {sandbox.label || sandbox.agentId || sandbox.id}
            </button>
          )}
          <button
            type="button"
            onClick={togglePause}
            className={`text-[10px] transition-colors ${
              isPaused ? 'text-amber-500 hover:text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            ● {isPaused ? 'paused' : 'active'}
          </button>
        </div>
      </div>

      {/* Live Metric Matrix (2-col grid like prototype) */}
      <div className="p-7 pt-5 pb-5">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          {/* Time Active */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-3)]">Time Active</span>
            <button
              type="button"
              onClick={togglePause}
              className={`text-[11px] text-left transition-colors flex items-center gap-1.5 ${
                isPaused ? 'text-amber-500' : 'text-white'
              }`}
            >
              {activeSeconds === null ? '—' : formatTime(activeSeconds)}
              <span className="text-[9px] text-[var(--fg-3)]">{isPaused ? '▶' : '❙❙'}</span>
            </button>
          </div>

          {/* Tokens */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-3)]">Tokens</span>
            <div className="text-[11px] text-white">
              <span className="text-[var(--fg-3)]">in</span> {fmtNum(sandbox.tokensIn)}{' '}
              <span className="text-[var(--fg-3)]">/</span>{' '}
              <span className="text-[var(--fg-3)]">out</span> {fmtNum(sandbox.tokensOut)}
            </div>
          </div>

          {/* Context */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-3)]">Context</span>
            <div className="text-[11px] text-white">
              {typeof sandbox.contextPct === 'number' ? (
                <span className="text-cyan-400">{Math.round(sandbox.contextPct)}%</span>
              ) : (
                '—'
              )}
            </div>
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-3)]">Model</span>
            <span className="text-[11px] text-zinc-400 truncate">{currentModel}</span>
          </div>

          {/* Agent */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-3)]">Agent</span>
            <span className="text-[11px] text-zinc-400">{sandbox.label || sandbox.agentId || sandbox.id}</span>
          </div>

          {/* Quota */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-3)]">Quota</span>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-[var(--fg-3)]">RPM</span>
              <span className="text-white">—/</span>
              <input
                type="number"
                value={rpmLimit}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setRpmLimit(val);
                  onUpdate?.({ rpmLimit: val });
                }}
                className="w-7 bg-transparent border-b border-[#222] text-[11px] text-white outline-none"
              />
              <span className="text-[var(--fg-3)]">|</span>
              <span className="text-[var(--fg-3)]">TPM</span>
              <span className="text-white">—/</span>
              <input
                type="number"
                value={tpmLimit}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setTpmLimit(val);
                  onUpdate?.({ tpmLimit: val });
                }}
                className="w-12 bg-transparent border-b border-[#222] text-[11px] text-white outline-none"
              />
            </div>
          </div>
        </div>

        {/* Progress Bar — only when the engine reports real progress */}
        {typeof sandbox.progress === 'number' && (
          <div className="mt-6 h-[1px] w-full rounded-full bg-[#1a1a1a] overflow-hidden">
            <div
              style={{ width: `${Math.max(0, Math.min(100, sandbox.progress))}%` }}
              className="h-full rounded-full bg-cyan-400 opacity-70"
            />
          </div>
        )}
      </div>

      {/* Main Body: Action Log + Live Workspace Viewports */}
      {!compact && (
        <div className="flex-1 flex flex-col md:flex-row min-h-[360px] divide-y md:divide-y-0 md:divide-x divide-[#1a1a1a] border-t border-[#1a1a1a]">
          {/* Action Log Left Half */}
          <div className="w-full md:w-[45%] flex flex-col min-h-0 bg-[#0F0F0F]">
            <SandboxActionLog
              actions={sandbox.actionLog || []}
              activeWorkspaceTab={activeTab}
              onTabChange={setActiveTab}
            />
          </div>

          {/* 4 Interactive Viewports Right Half */}
          <div className="w-full md:w-[55%] flex flex-col min-h-0 bg-[#0c0c0c]">
            {/* Viewport Tabs */}
            <div className="flex items-center border-b border-[#1a1a1a] bg-[#0c0c0c] shrink-0 text-[10px] px-2 h-9 gap-1">
              <button
                type="button"
                onClick={() => setActiveTab('browser')}
                className={`px-2.5 py-1 rounded-md uppercase tracking-wider text-[10px] transition-all ${
                  activeTab === 'browser'
                    ? 'bg-[#161616] text-white border border-[#1e1e1e]'
                    : 'text-[var(--fg-3)] hover:text-zinc-300'
                }`}
              >
                Browser
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('editor')}
                className={`px-2.5 py-1 rounded-md uppercase tracking-wider text-[10px] transition-all ${
                  activeTab === 'editor'
                    ? 'bg-[#161616] text-white border border-[#1e1e1e]'
                    : 'text-[var(--fg-3)] hover:text-zinc-300'
                }`}
              >
                Editor
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('terminal')}
                className={`px-2.5 py-1 rounded-md uppercase tracking-wider text-[10px] transition-all ${
                  activeTab === 'terminal'
                    ? 'bg-[#161616] text-white border border-[#1e1e1e]'
                    : 'text-[var(--fg-3)] hover:text-zinc-300'
                }`}
              >
                Terminal
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('blackboard')}
                className={`px-2.5 py-1 rounded-md uppercase tracking-wider text-[10px] transition-all ${
                  activeTab === 'blackboard'
                    ? 'bg-[#161616] text-white border border-[#1e1e1e]'
                    : 'text-[var(--fg-3)] hover:text-zinc-300'
                }`}
              >
                Blackboard
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('graph')}
                className={`px-2.5 py-1 rounded-md uppercase tracking-wider text-[10px] transition-all ${
                  activeTab === 'graph'
                    ? 'bg-[#161616] text-white border border-[#1e1e1e]'
                    : 'text-[var(--fg-3)] hover:text-zinc-300'
                }`}
              >
                Graph
              </button>
            </div>

            {/* Viewport Content */}
            <div className="flex-1 flex flex-col min-h-0">
              {activeTab === 'browser' && (
                <SandboxBrowserPane
                  url={sandbox.url}
                  screenshotUrl={sandbox.screenshotUrl}
                  logs={sandbox.logs}
                />
              )}
              {activeTab === 'editor' && (
                <SandboxEditorPane
                  filePath={sandbox.filesWritten?.[0]}
                  diffLines={sandbox.diffPreview}
                  fleetReview={fleetReview}
                  sessionId={sessionId}
                  liveStream={fleetReview && Boolean(sessionId)}
                />
              )}
              {activeTab === 'terminal' && (
                <SandboxMissionTerminal sandbox={sandbox} className="h-full rounded-none border-0" />
              )}
              {activeTab === 'blackboard' && (
                <SandboxBlackboardPane
                  entries={sandbox.blackboardEntries}
                  thoughtStream={sandbox.thoughtStream}
                  contextPct={sandbox.contextPct}
                  tokensIn={sandbox.tokensIn}
                  tokensOut={sandbox.tokensOut}
                  thinking={sandbox.status === 'running' && sandbox.actionLog?.[sandbox.actionLog.length - 1]?.type === 'think'}
                />
              )}
              {activeTab === 'graph' && (
                <SandboxGraphPane
                  agentId={sandbox.agentId || sandbox.id}
                  agentLabel={sandbox.label}
                  archetype={currentArchetype}
                  childIds={sandbox.childIds}
                  parentId={sandbox.parentId}
                  connected={sandbox.status === 'running'}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
