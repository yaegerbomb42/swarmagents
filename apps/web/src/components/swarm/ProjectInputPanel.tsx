'use client';

import { useState, useCallback } from 'react';
import { Clock, Send, Loader2, AlertTriangle, ChevronDown, Zap } from 'lucide-react';
import { useSwarmStore } from '@/stores/swarmStore';

const TIME_PRESETS = [
  { label: '30 min', value: '30 minutes' },
  { label: '1 hr', value: '1 hour' },
  { label: '3 hrs', value: '3 hours' },
  { label: '6 hrs', value: '6 hours' },
  { label: '1 day', value: '1 day' },
  { label: '3 days', value: '3 days' },
  { label: '1 week', value: '1 week' },
  { label: 'Open-ended', value: 'open-ended' },
];

export default function ProjectInputPanel() {
  const [projectDesc, setProjectDesc] = useState('');
  const [timeRequirement, setTimeRequirement] = useState('3 hours');
  const [showTimePresets, setShowTimePresets] = useState(false);

  const {
    decompSession,
    decompLoading,
    decompError,
    setDecompSession,
    setDecompLoading,
    setDecompError,
    addToast,
  } = useSwarmStore();

  const handleSubmit = useCallback(async () => {
    if (!projectDesc.trim()) {
      addToast('Enter a project description first', 'error');
      return;
    }

    setDecompLoading(true);
    setDecompError(null);

    // Show optimistic UI: session with project info
    setDecompSession({
      id: `session-optimistic-${Date.now()}`,
      project: projectDesc,
      timeRequirement,
      nodes: [],
      project_title: projectDesc.slice(0, 60),
      total_effort: '',
      status: 'active',
      createdAt: Date.now(),
    });

    try {
      const res = await fetch('/api/tasks/decompose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'decompose',
          project: projectDesc,
          timeRequirement,
        }),
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Decomposition failed');

      setDecompSession(data.session);
      addToast(`Project decomposed into ${countLeaves(data.session.nodes)} tasks`, 'success');
    } catch (e: any) {
      setDecompError(e.message || 'Failed to decompose project');
      setDecompSession(null);
      addToast(`Error: ${e.message}`, 'error');
    } finally {
      setDecompLoading(false);
    }
  }, [projectDesc, timeRequirement, setDecompSession, setDecompLoading, setDecompError, addToast]);

  const countLeaves = (nodes: any[]): number => {
    let count = 0;
    for (const n of nodes) {
      if (n.children && n.children.length > 0) {
        count += countLeaves(n.children);
      } else {
        count++;
      }
    }
    return count;
  };

  const handleReset = () => {
    setDecompSession(null);
    setProjectDesc('');
    setTimeRequirement('3 hours');
    setDecompError(null);
  };

  // If session exists, show condensed input header at top
  if (decompSession) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#06061a] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-medium text-white/80 truncate">
                {decompSession.project_title}
              </div>
              <div className="text-[10px] text-white/30 flex items-center gap-2">
                <span>{decompSession.timeRequirement}</span>
                <span className="text-white/10">|</span>
                <span>{decompSession.total_effort || 'estimating...'}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                const count = countLeaves(decompSession.nodes);
                addToast(`${count} leaf tasks in tree`, 'info');
              }}
              className="text-[10px] text-cyan-400/60 hover:text-cyan-300 px-2 py-1 rounded hover:bg-cyan-500/10 transition-colors"
            >
              {countLeaves(decompSession.nodes)} tasks
            </button>
            <button
              onClick={handleReset}
              className="text-[10px] text-white/30 hover:text-white/60 px-2 py-1 rounded hover:bg-white/5 transition-colors"
            >
              New
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Full input panel
  return (
    <div className="space-y-4">
      {/* Time requirement selector */}
      <div className="relative">
        <label className="text-[10px] uppercase tracking-[0.15em] text-white/40 mb-2 flex items-center gap-1.5">
          <Clock size={11} className="text-cyan-400/60" />
          Time Requirement
        </label>
        <button
          onClick={() => setShowTimePresets(!showTimePresets)}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] text-xs text-white/70 hover:border-white/[0.12] transition-colors"
        >
          <span>{timeRequirement}</span>
          <ChevronDown size={12} className={`text-white/30 transition-transform ${showTimePresets ? 'rotate-180' : ''}`} />
        </button>
        {showTimePresets && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-white/[0.06] bg-[#06061a] shadow-xl shadow-black/40 overflow-hidden">
            {TIME_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => {
                  setTimeRequirement(preset.value);
                  setShowTimePresets(false);
                }}
                className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                  timeRequirement === preset.value
                    ? 'text-cyan-300 bg-cyan-500/10'
                    : 'text-white/50 hover:text-white/80 hover:bg-white/[0.03]'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Project description */}
      <div>
        <label className="text-[10px] uppercase tracking-[0.15em] text-white/40 mb-2 flex items-center gap-1.5">
          <Zap size={11} className="text-cyan-400/60" />
          Project Description
        </label>
        <textarea
          value={projectDesc}
          onChange={(e) => setProjectDesc(e.target.value)}
          placeholder={`Describe your project in detail...

Examples:
• Build a full-stack todo app with Next.js, PostgreSQL, and Docker
• Write a research paper on reinforcement learning for robotics
• Create an interactive data visualization dashboard for climate data

The more detail you provide, the better the decomposition.`}
          className="w-full bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2.5 text-xs text-white/70 placeholder-white/20 resize-none outline-none focus:border-cyan-500/30 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
          rows={8}
        />
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={decompLoading || !projectDesc.trim()}
        className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-teal-500 text-black text-xs font-semibold px-4 py-3 rounded-lg hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {decompLoading ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Decomposing...
          </>
        ) : (
          <>
            <Send size={14} />
            Decompose Project
          </>
        )}
      </button>

      {/* Error */}
      {decompError && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300/80">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{decompError}</span>
        </div>
      )}
    </div>
  );
}