"use client";

import { useState, useEffect } from 'react';
import { Plus, Trash2, UserCheck, Award, TrendingUp } from 'lucide-react';

interface CapabilityEntry {
  name: string;
  proficiency: number;
  experienceHours: number;
  taskCount: number;
  lastUsed: number;
  verified: boolean;
}

interface CapabilityProfile {
  id: string;
  agentId: string;
  agentName: string;
  capabilitySet: CapabilityEntry[];
  proficiencyLevel: number;
  experienceHours: number;
  taskCount: number;
  performanceMetrics: {
    quality: number;
    speed: number;
    reliability: number;
    collaboration: number;
  };
  lastUpdated: number;
}

export default function CapabilityProfilePanel() {
  const [profiles, setProfiles] = useState<CapabilityProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newProfile, setNewProfile] = useState({
    agentName: '',
    capabilities: [{ name: '', proficiency: 50, experienceHours: 0, taskCount: 0, verified: false }],
  });

  useEffect(() => {
    fetchProfiles();
  }, []);

  const fetchProfiles = async () => {
    try {
      const res = await fetch('/api/capabilities');
      const data = await res.json();
      if (data.ok) setProfiles(data.profiles || []);
    } catch (e) {
      console.error('Failed to fetch profiles:', e);
    }
  };

  const createProfile = async () => {
    if (!newProfile.agentName.trim()) return;
    const validCaps = newProfile.capabilities.filter((c) => c.name.trim());
    if (!validCaps.length) return;

    setLoading(true);
    try {
      const body = {
        agentId: `agent-${Date.now()}`,
        agentName: newProfile.agentName,
        capabilitySet: validCaps.map((c) => ({
          ...c,
          lastUsed: Date.now(),
        })),
        experienceHours: validCaps.reduce((s, c) => s + c.experienceHours, 0),
        taskCount: validCaps.reduce((s, c) => s + c.taskCount, 0),
        performanceMetrics: { quality: 80, speed: 75, reliability: 85, collaboration: 70 },
        capabilityVersion: '1.0.0',
        metadata: {},
      };

      const res = await fetch('/api/capabilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setProfiles((prev) => [data.profile, ...prev]);
        setShowCreate(false);
        setNewProfile({ agentName: '', capabilities: [{ name: '', proficiency: 50, experienceHours: 0, taskCount: 0, verified: false }] });
      }
    } finally {
      setLoading(false);
    }
  };

  const deleteProfile = async (id: string) => {
    try {
      await fetch(`/api/capabilities?id=${id}`, { method: 'DELETE' });
      setProfiles((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      console.error('Failed to delete profile:', e);
    }
  };

  const addCapability = () => {
    setNewProfile((prev) => ({
      ...prev,
      capabilities: [...prev.capabilities, { name: '', proficiency: 50, experienceHours: 0, taskCount: 0, verified: false }],
    }));
  };

  const updateCapability = (idx: number, field: keyof CapabilityEntry, value: any) => {
    setNewProfile((prev) => ({
      ...prev,
      capabilities: prev.capabilities.map((c, i) => (i === idx ? { ...c, [field]: value } : c)),
    }));
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-white/40">
          {profiles.length} profile{profiles.length !== 1 ? 's' : ''} registered
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-300 text-[12px] font-medium hover:bg-violet-500/30 transition"
        >
          <Plus size={14} /> {showCreate ? 'Cancel' : 'Create Profile'}
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="rounded-lg border border-violet-500/20 bg-black/30 p-4 space-y-3">
          <div>
            <label className="text-[11px] text-white/40 block mb-1">Agent Name</label>
            <input
              value={newProfile.agentName}
              onChange={(e) => setNewProfile((p) => ({ ...p, agentName: e.target.value }))}
              placeholder="e.g. Codebase Specialist"
              className="w-full px-3 py-2 rounded bg-black/40 border border-white/10 text-[13px] text-white/70 focus:outline-none focus:border-violet-400/40"
            />
          </div>

          <div className="text-[11px] text-white/40">Capabilities</div>
          {newProfile.capabilities.map((cap, idx) => (
            <div key={idx} className="grid grid-cols-4 gap-2">
              <input
                value={cap.name}
                onChange={(e) => updateCapability(idx, 'name', e.target.value)}
                placeholder="capability name"
                className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
              />
              <input
                type="number"
                value={cap.proficiency}
                onChange={(e) => updateCapability(idx, 'proficiency', Number(e.target.value))}
                placeholder="0-100"
                min={0}
                max={100}
                className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
              />
              <input
                type="number"
                value={cap.experienceHours}
                onChange={(e) => updateCapability(idx, 'experienceHours', Number(e.target.value))}
                placeholder="hours"
                className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
              />
              <input
                type="number"
                value={cap.taskCount}
                onChange={(e) => updateCapability(idx, 'taskCount', Number(e.target.value))}
                placeholder="tasks"
                className="px-2 py-1.5 rounded bg-black/40 border border-white/10 text-[12px] text-white/70 focus:outline-none focus:border-violet-400/40"
              />
            </div>
          ))}

          <div className="flex items-center gap-2">
            <button onClick={addCapability} className="text-[11px] text-violet-300/60 hover:text-violet-300 transition">
              + Add capability
            </button>
            <button
              onClick={createProfile}
              disabled={loading}
              className="ml-auto px-4 py-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-purple-500 text-white text-[12px] font-medium hover:brightness-110 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Profile'}
            </button>
          </div>
        </div>
      )}

      {/* Profile List */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {profiles.length === 0 && (
          <div className="text-center py-8 text-[12px] text-white/25">
            No capability profiles yet. Create one to enable dynamic team formation.
          </div>
        )}
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="rounded-lg border border-white/[0.06] bg-black/20 p-3 hover:border-violet-500/20 transition"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <UserCheck size={14} className="text-violet-400/60" />
                <span className="text-[13px] font-medium text-white/70">{profile.agentName}</span>
                <span className="text-[10px] font-mono text-white/30 bg-white/5 px-1.5 py-px rounded">{profile.agentId}</span>
              </div>
              <button
                onClick={() => deleteProfile(profile.id)}
                className="text-white/20 hover:text-red-400/70 transition"
              >
                <Trash2 size={13} />
              </button>
            </div>

            <div className="flex items-center gap-3 mb-2">
              <div className="flex items-center gap-1 text-[11px] text-white/40">
                <Award size={12} className="text-amber-400/50" />
                L{profile.proficiencyLevel}
              </div>
              <div className="flex items-center gap-1 text-[11px] text-white/40">
                <TrendingUp size={12} className="text-emerald-400/50" />
                {profile.taskCount} tasks
              </div>
              <div className="text-[11px] text-white/30">{profile.experienceHours}h exp</div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {profile.capabilitySet.map((cap) => (
                <span
                  key={cap.name}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300/60 border border-violet-500/10"
                >
                  {cap.name} · {cap.proficiency}%
                </span>
              ))}
            </div>

            {/* Performance bars */}
            <div className="grid grid-cols-4 gap-2 mt-2">
              {(['quality', 'speed', 'reliability', 'collaboration'] as const).map((metric) => (
                <div key={metric}>
                  <div className="text-[9px] uppercase text-white/25 mb-0.5">{metric}</div>
                  <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-violet-400/50"
                      style={{ width: `${profile.performanceMetrics[metric]}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
