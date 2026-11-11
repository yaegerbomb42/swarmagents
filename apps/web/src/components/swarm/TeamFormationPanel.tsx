"use client";

import { useState } from 'react';
import { Users, GitMerge, Shuffle, Target, Gauge } from 'lucide-react';

interface CapabilityRequirement {
  capability: string;
  minimumProficiency: number;
  weight: number;
  type: 'mandatory' | 'optional' | 'nice-to-have';
}

interface MatchResult {
  agentId: string;
  agentName: string;
  totalScore: number;
  confidence: number;
  matchedRequirements: number;
  totalRequirements: number;
  missingCapabilities: string[];
}

interface FormedTeam {
  id: string;
  members: MatchResult[];
  coverage: number;
  diversityScore: number;
  predictedPerformance: number;
  formationStrategy: string;
  formedAt: number;
}

export default function TeamFormationPanel() {
  const [requirements, setRequirements] = useState<CapabilityRequirement[]>([
    { capability: '', minimumProficiency: 50, weight: 1, type: 'mandatory' },
  ]);
  const [strategy, setStrategy] = useState<'stigmergy' | 'capability-based' | 'performance-based' | 'diversity-based' | 'minimal'>('capability-based');
  const [minTeamSize, setMinTeamSize] = useState(1);
  const [maxTeamSize, setMaxTeamSize] = useState(5);
  const [team, setTeam] = useState<FormedTeam | null>(null);
  const [loading, setLoading] = useState(false);

  const addRequirement = () => {
    setRequirements((prev) => [...prev, { capability: '', minimumProficiency: 50, weight: 1, type: 'mandatory' }]);
  };

  const updateRequirement = (idx: number, field: keyof CapabilityRequirement, value: any) => {
    setRequirements((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };

  const removeRequirement = (idx: number) => {
    setRequirements((prev) => prev.filter((_, i) => i !== idx));
  };

  const formTeam = async () => {
    const validReqs = requirements.filter((r) => r.capability.trim());
    if (!validReqs.length) return;

    setLoading(true);
    try {
      const res = await fetch('/api/capabilities/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskRequirements: validReqs,
          minTeamSize,
          maxTeamSize,
          strategy,
        }),
      });
      const data = await res.json();
      if (data.ok) setTeam(data.team);
    } catch (e) {
      console.error('Failed to form team:', e);
    } finally {
      setLoading(false);
    }
  };

  const strategyDescriptions: Record<string, string> = {
    stigmergy: 'Self-organizing response thresholds',
    'capability-based': 'Best capability coverage',
    'performance-based': 'Highest performance agents',
    'diversity-based': 'Jaccard-diverse skill sets',
    minimal: 'Smallest team via greedy set cover',
  };

  return (
    <div className="space-y-4">
      {/* Requirements */}
      <div className="rounded-lg border border-violet-500/20 bg-black/30 p-4 space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-white/30">Task Requirements</div>
        {requirements.map((req, idx) => (
          <div key={idx} className="grid grid-cols-5 gap-2 items-center">
            <input
              value={req.capability}
              onChange={(e) => updateRequirement(idx, 'capability', e.target.value)}
              placeholder="capability name"
              className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
            />
            <input
              type="number"
              value={req.minimumProficiency}
              onChange={(e) => updateRequirement(idx, 'minimumProficiency', Number(e.target.value))}
              placeholder="min %"
              min={0}
              max={100}
              className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
            />
            <input
              type="number"
              value={req.weight}
              onChange={(e) => updateRequirement(idx, 'weight', Number(e.target.value))}
              placeholder="weight"
              step={0.1}
              min={0}
              max={2}
              className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
            />
            <select
              value={req.type}
              onChange={(e) => updateRequirement(idx, 'type', e.target.value)}
              className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
            >
              <option value="mandatory">mandatory</option>
              <option value="optional">optional</option>
              <option value="nice-to-have">nice-to-have</option>
            </select>
            <button
              onClick={() => removeRequirement(idx)}
              className="text-white/20 hover:text-red-400/70 transition text-[11px]"
            >
              Remove
            </button>
          </div>
        ))}
        <button onClick={addRequirement} className="text-[11px] text-violet-300/60 hover:text-violet-300 transition">
          + Add requirement
        </button>
      </div>

      {/* Strategy & Size */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-2">Formation Strategy</div>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as any)}
            className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40 mb-1"
          >
            <option value="stigmergy">stigmergy</option>
            <option value="capability-based">capability-based</option>
            <option value="performance-based">performance-based</option>
            <option value="diversity-based">diversity-based</option>
            <option value="minimal">minimal</option>
          </select>
          <div className="text-[10px] text-white/25">{strategyDescriptions[strategy]}</div>
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-2">Team Size</div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-white/40">Min</span>
            <input
              type="number"
              value={minTeamSize}
              onChange={(e) => setMinTeamSize(Number(e.target.value))}
              min={1}
              max={10}
              className="w-12 px-1.5 py-1 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 text-center"
            />
            <span className="text-[10px] text-white/40">Max</span>
            <input
              type="number"
              value={maxTeamSize}
              onChange={(e) => setMaxTeamSize(Number(e.target.value))}
              min={1}
              max={20}
              className="w-12 px-1.5 py-1 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 text-center"
            />
          </div>
        </div>
      </div>

      <button
        onClick={formTeam}
        disabled={loading}
        className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-gradient-to-r from-violet-500 to-purple-500 text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-50"
      >
        <Users size={14} /> {loading ? 'Forming Team...' : 'Form Team'}
      </button>

      {/* Results */}
      {team && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.02] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitMerge size={14} className="text-emerald-400/60" />
              <span className="text-[13px] font-semibold text-emerald-300/70">Team {team.id.slice(0, 8)}</span>
            </div>
            <span className="text-[10px] font-mono text-white/30">{team.formationStrategy}</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="text-center rounded bg-black/20 p-2">
              <div className="text-[9px] uppercase text-white/25">Coverage</div>
              <div className="text-[14px] font-semibold text-emerald-300/60">{(team.coverage * 100).toFixed(0)}%</div>
            </div>
            <div className="text-center rounded bg-black/20 p-2">
              <div className="text-[9px] uppercase text-white/25">Diversity</div>
              <div className="text-[14px] font-semibold text-emerald-300/60">{(team.diversityScore * 100).toFixed(0)}%</div>
            </div>
            <div className="text-center rounded bg-black/20 p-2">
              <div className="text-[9px] uppercase text-white/25">Performance</div>
              <div className="text-[14px] font-semibold text-emerald-300/60">{team.predictedPerformance}</div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-white/30">Members</div>
            {team.members.map((member) => (
              <div
                key={member.agentId}
                className="flex items-center justify-between rounded bg-black/20 p-2"
              >
                <div className="flex items-center gap-2">
                  <Target size={12} className="text-violet-400/50" />
                  <span className="text-[12px] text-white/60">{member.agentName}</span>
                  <span className="text-[10px] font-mono text-white/25">{member.agentId.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-emerald-300/50">{member.totalScore.toFixed(0)} pts</span>
                  <span className="text-white/20">{(member.confidence * 100).toFixed(0)}% conf</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
