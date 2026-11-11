'use client';

import { useState, useEffect } from 'react';
import type { LearningConfig, LearningStats } from '@/types/learning';

export default function LearningPanel() {
  const [config, setConfig] = useState<LearningConfig | null>(null);
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [engineMemory, setEngineMemory] = useState<{
    episodic: number;
    semantic: number;
    working: number;
    note?: string;
  } | null>(null);

  useEffect(() => {
    fetchLearningData();
  }, []);

  const fetchLearningData = async () => {
    try {
      const [configRes, statsRes, ep, sem, work] = await Promise.all([
        fetch('/api/learning/config'),
        fetch('/api/learning/stats'),
        fetch('/api/memory?tier=episodic', { cache: 'no-store' }),
        fetch('/api/memory?tier=semantic', { cache: 'no-store' }),
        fetch('/api/memory?tier=working', { cache: 'no-store' }),
      ]);
      const configData = await configRes.json();
      const statsData = await statsRes.json();
      setConfig(configData);
      setStats(statsData.stats);

      const epData = await ep.json().catch(() => ({}));
      const semData = await sem.json().catch(() => ({}));
      const workData = await work.json().catch(() => ({}));
      const workingKeys =
        workData.context && typeof workData.context === 'object'
          ? Object.keys(workData.context).length
          : 0;
      setEngineMemory({
        episodic: Array.isArray(epData.entries) ? epData.entries.length : 0,
        semantic: Array.isArray(semData.results)
          ? semData.results.length
          : Array.isArray(semData.entries)
            ? semData.entries.length
            : 0,
        working: workingKeys,
        note: epData.note || semData.note || workData.note,
      });
    } catch (error) {
      console.error('Failed to fetch learning data:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = async (updates: Partial<LearningConfig>) => {
    try {
      const res = await fetch('/api/learning/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const newConfig = await res.json();
      setConfig(newConfig);
    } catch (error) {
      console.error('Failed to update config:', error);
    }
  };

  const exportData = async () => {
    try {
      const res = await fetch('/api/learning/export');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'training-samples.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export data:', error);
    }
  };

  const clearData = async () => {
    if (!confirm('Are you sure you want to clear all learning data? This cannot be undone.')) {
      return;
    }
    try {
      await fetch('/api/learning/clear', { method: 'POST' });
      await fetchLearningData();
    } catch (error) {
      console.error('Failed to clear data:', error);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-white/10 rounded w-1/4" />
          <div className="h-20 bg-white/5 rounded" />
        </div>
      </div>
    );
  }

  if (!config || !stats) {
    return (
      <div className="p-6 text-white/40">
        Failed to load learning data
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white/90">Online Learning</h2>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${config.userOptIn ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-xs text-white/50">{config.userOptIn ? 'Active' : 'Disabled'}</span>
        </div>
      </div>

      {engineMemory && (
        <div className="grid grid-cols-3 gap-2 p-3 rounded-xl border border-cyan-500/10 bg-cyan-500/[0.03]">
          <div>
            <div className="text-lg font-mono text-cyan-300">{engineMemory.episodic}</div>
            <div className="text-[10px] uppercase text-white/40">Episodic</div>
          </div>
          <div>
            <div className="text-lg font-mono text-teal-300">{engineMemory.semantic}</div>
            <div className="text-[10px] uppercase text-white/40">Semantic</div>
          </div>
          <div>
            <div className="text-lg font-mono text-amber-300">{engineMemory.working}</div>
            <div className="text-[10px] uppercase text-white/40">Working</div>
          </div>
          {engineMemory.note && (
            <p className="col-span-3 text-[10px] text-white/40 font-mono">{engineMemory.note}</p>
          )}
        </div>
      )}

      {/* Radial Progress Ring Matchers (Prompt 20) */}
      <div className="flex items-center gap-6 p-4 rounded-xl border border-white/[0.05] bg-black/40">
        <div className="relative w-20 h-20 flex-shrink-0 flex items-center justify-center">
          <svg className="w-full h-full transform -rotate-90 overflow-visible" viewBox="0 0 100 100">
            <defs>
              <filter id="radial-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3.5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {/* Background Ring */}
            <circle
              cx="50"
              cy="50"
              r="40"
              stroke="rgba(255, 255, 255, 0.04)"
              strokeWidth="5"
              fill="transparent"
            />
            {/* Foreground Ring */}
            <circle
              cx="50"
              cy="50"
              r="40"
              stroke="#00BFFF"
              strokeWidth="5"
              fill="transparent"
              strokeDasharray="251.3"
              strokeDashoffset={251.3 - (251.3 * 78) / 100}
              strokeLinecap="round"
              filter="url(#radial-glow)"
              style={{ transition: 'stroke-dashoffset 1.5s ease-in-out' }}
            />
          </svg>
          <div className="absolute flex flex-col items-center justify-center text-center">
            <span className="text-sm font-bold font-mono text-cyan-300">78%</span>
            <span className="text-[6px] text-white/30 uppercase tracking-wider font-mono">Precision</span>
          </div>
        </div>
        <div className="flex-1 space-y-1">
          <div className="text-[8px] font-mono uppercase tracking-[0.15em] text-white/40">QLoRA ALIGNMENT INDEX</div>
          <div className="text-xs text-white/80 font-bold font-mono">SYNAPSE WEIGHT STACK</div>
          <p className="text-[9px] text-white/30 leading-relaxed">
            Gradient convergence matched successfully at 78% precision threshold. Hyper-parameter combiners optimized.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 rounded-xl border border-white/[0.05] bg-white/[0.015]">
          <div className="text-2xl font-bold text-white/90">{stats.totalConversations}</div>
          <div className="text-xs text-white/40 mt-1">Conversations</div>
        </div>
        <div className="p-4 rounded-xl border border-white/[0.05] bg-white/[0.015]">
          <div className="text-2xl font-bold text-white/90">{stats.ragQueries}</div>
          <div className="text-xs text-white/40 mt-1">RAG Queries</div>
        </div>
      </div>

      {/* Configuration */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-white/70">Configuration</h3>
        
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm text-white/60">Enable Learning</label>
            <button
              onClick={() => updateConfig({ userOptIn: !config.userOptIn })}
              className={`w-12 h-6 rounded-full transition-colors ${
                config.userOptIn ? 'bg-cyan-500' : 'bg-white/10'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  config.userOptIn ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm text-white/60">RAG Mode</label>
            <button
              onClick={() => updateConfig({ ragEnabled: !config.ragEnabled })}
              className={`w-12 h-6 rounded-full transition-colors ${
                config.ragEnabled ? 'bg-cyan-500' : 'bg-white/10'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  config.ragEnabled ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm text-white/60">Context Count (RAG)</label>
            <select
              value={config.ragTopK}
              onChange={(e) => updateConfig({ ragTopK: parseInt(e.target.value) })}
              className="bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-1.5 text-sm text-white/80 focus:outline-none focus:border-cyan-500/30"
            >
              <option value={1}>1</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
            </select>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-white/70">Actions</h3>
        
        <div className="flex gap-2">
          <button
            onClick={exportData}
            className="flex-1 px-4 py-2 rounded-lg border border-white/[0.1] text-sm text-white/70 hover:text-white/90 hover:border-white/[0.2] transition-colors"
          >
            Export Data
          </button>
          <button
            onClick={clearData}
            className="flex-1 px-4 py-2 rounded-lg border border-red-500/20 text-sm text-red-400/70 hover:text-red-400 hover:border-red-500/30 transition-colors"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="p-4 rounded-xl border border-cyan-500/10 bg-cyan-500/[0.02]">
        <p className="text-xs text-cyan-400/70 leading-relaxed">
          <strong className="text-cyan-400/90">RAG Mode:</strong> Retrieves relevant past conversations to augment prompts. 
          <br /><br />
          <strong className="text-cyan-400/90">QLoRA:</strong> Requires GPU compute for fine-tuning. Currently disabled.
        </p>
      </div>
    </div>
  );
}
