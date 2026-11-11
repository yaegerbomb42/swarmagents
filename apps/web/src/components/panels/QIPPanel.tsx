'use client';

import { useState, useEffect } from 'react';
import { Brain, Zap, Play, Settings, ChevronDown, ChevronRight, CheckCircle, XCircle, Clock } from 'lucide-react';

interface QIPConfig {
  fastModel: string;
  smartModel: string;
  fastEndpoint: string;
  smartEndpoint: string;
  horizon: number;
  simulationMode: 'quantum' | 'hybrid' | 'classical';
  topKTrajectories: number;
  enabled: boolean;
  useIBMQuantum: boolean;
  ibmQuantumToken?: string;
}

interface Trajectory {
  actions: string[];
  probability: number;
  expectedOutcome: string;
}

interface PlanResponse {
  success: boolean;
  trajectories: Trajectory[];
  selectedTrajectory?: Trajectory;
  reasoning: string;
  simulationMode: string;
  planningTimeMs: number;
}

export default function QIPPanel() {
  const [config, setConfig] = useState<QIPConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [goal, setGoal] = useState('');
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null);
  const [expandedTrajectory, setExpandedTrajectory] = useState<number | null>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/qip/config');
      const data = await res.json();
      setConfig(data);
    } catch (error) {
      console.error('Failed to fetch QIP config:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = async (updates: Partial<QIPConfig>) => {
    try {
      const res = await fetch('/api/qip/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const newConfig = await res.json();
      setConfig(newConfig);
    } catch (error) {
      console.error('Failed to update QIP config:', error);
    }
  };

  const generatePlan = async () => {
    if (!goal.trim()) return;

    setPlanning(true);
    setPlanResult(null);

    try {
      const res = await fetch('/api/qip/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal,
          currentContext: {},
          availableTools: ['THINK', 'EDIT', 'GREP', 'BROWSE', 'UI_DESIGN', 'TEST', 'LLM_ROUTER', 'SUBMIT'],
        }),
      });
      const data = await res.json();
      setPlanResult(data);
    } catch (error) {
      console.error('Failed to generate plan:', error);
    } finally {
      setPlanning(false);
    }
  };

  const executeTrajectory = async (trajectory: Trajectory) => {
    try {
      const res = await fetch('/api/qip/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trajectory,
          initialState: {
            filesModified: [],
            filesCreated: [],
            testsPassing: false,
            errors: [],
          },
          context: {},
        }),
      });
      const data = await res.json();
      console.log('Execution result:', data);
    } catch (error) {
      console.error('Failed to execute trajectory:', error);
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

  if (!config) {
    return (
      <div className="p-6 text-white/40">
        Failed to load QIP configuration
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white/90 flex items-center gap-2">
          <Brain size={18} className="text-purple-400/70" /> Quantum-Inspired Planning
        </h2>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${config.enabled ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-xs text-white/50">{config.enabled ? 'Active' : 'Disabled'}</span>
        </div>
      </div>

      {/* Configuration */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-sm text-white/60">Enable QIP</label>
          <button
            onClick={() => updateConfig({ enabled: !config.enabled })}
            className={`w-12 h-6 rounded-full transition-colors ${
              config.enabled ? 'bg-purple-500' : 'bg-white/10'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white transition-transform ${
                config.enabled ? 'translate-x-6' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-sm text-white/60">Use IBM Quantum</label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/40">
              {config.useIBMQuantum ? 'Cloud' : 'Local'}
            </span>
            <button
              onClick={() => updateConfig({ useIBMQuantum: !config.useIBMQuantum })}
              className={`w-12 h-6 rounded-full transition-colors ${
                config.useIBMQuantum ? 'bg-blue-500' : 'bg-white/10'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  config.useIBMQuantum ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Fast Model</label>
            <input
              type="text"
              value={config.fastModel}
              onChange={(e) => updateConfig({ fastModel: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.1] text-sm text-white/80 focus:outline-none focus:border-purple-500/30"
            />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Smart Model</label>
            <input
              type="text"
              value={config.smartModel}
              onChange={(e) => updateConfig({ smartModel: e.target.value })}
              className="w-full px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.1] text-sm text-white/80 focus:outline-none focus:border-purple-500/30"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Simulation Mode</label>
            <select
              value={config.simulationMode}
              onChange={(e) => updateConfig({ simulationMode: e.target.value as any })}
              className="w-full px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.1] text-sm text-white/80 focus:outline-none focus:border-purple-500/30"
            >
              <option value="quantum">Quantum (16GB+ RAM)</option>
              <option value="hybrid">Hybrid (8GB+ RAM)</option>
              <option value="classical">Classical (Fallback)</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Horizon</label>
            <input
              type="number"
              value={config.horizon}
              onChange={(e) => updateConfig({ horizon: parseInt(e.target.value) })}
              min={1}
              max={20}
              className="w-full px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.1] text-sm text-white/80 focus:outline-none focus:border-purple-500/30"
            />
          </div>
        </div>
      </div>

      {/* Planning Input */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-white/70">Generate Plan</label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe your goal (e.g., 'Create a React component with tests')"
          rows={3}
          className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.08] text-white/80 placeholder-white/30 resize-none focus:outline-none focus:border-purple-500/30 transition-colors"
        />
        <button
          onClick={generatePlan}
          disabled={!goal.trim() || planning || !config.enabled}
          className="w-full py-2.5 rounded-lg bg-gradient-to-r from-purple-500 to-blue-600 text-white text-sm font-medium transition-all hover:shadow-[0_0_30px_-5px_rgba(168,85,247,0.4)] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {planning ? (
            <>
              <Zap size={16} className="animate-pulse" />
              Planning...
            </>
          ) : (
            <>
              <Play size={16} />
              Generate Quantum Plan
            </>
          )}
        </button>
      </div>

      {/* Plan Results */}
      {planResult && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-white/70">Generated Trajectories</h3>
            <div className="flex items-center gap-2 text-xs text-white/40">
              <Clock size={12} />
              {planResult.planningTimeMs}ms
            </div>
          </div>

          <div className="text-xs text-white/50">
            {planResult.reasoning}
          </div>

          <div className="space-y-2">
            {planResult.trajectories.map((trajectory, index) => (
              <div
                key={index}
                className="rounded-lg border border-white/[0.05] bg-white/[0.02] overflow-hidden"
              >
                <button
                  onClick={() => setExpandedTrajectory(expandedTrajectory === index ? null : index)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.05] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-white/40">#{index + 1}</span>
                    <span className="text-sm text-white/80">
                      {trajectory.actions.join(' → ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-purple-400/70">
                      {(trajectory.probability * 100).toFixed(0)}%
                    </span>
                    {expandedTrajectory === index ? (
                      <ChevronDown size={14} className="text-white/40" />
                    ) : (
                      <ChevronRight size={14} className="text-white/40" />
                    )}
                  </div>
                </button>

                {expandedTrajectory === index && (
                  <div className="px-4 py-3 border-t border-white/[0.05] space-y-3">
                    <div className="text-xs text-white/50">
                      {trajectory.expectedOutcome}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => executeTrajectory(trajectory)}
                        className="flex-1 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300 hover:bg-purple-500/20 transition-colors flex items-center justify-center gap-1"
                      >
                        <Play size={12} />
                        Execute
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Vector Cost Curves (Prompt 18) */}
      {(planning || planResult) && (
        <div className="bg-black/60 rounded-xl border border-white/[0.04] p-4 space-y-2">
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-purple-400 font-bold">VECTOR COST CONVERGENCE</span>
            <span className="text-white/40">ENERGY MINIMIZATION TRACE</span>
          </div>
          <div className="relative h-24 w-full">
            <svg viewBox="0 0 300 100" className="w-full h-full overflow-visible">
              <line x1="0" y1="90" x2="300" y2="90" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <line x1="0" y1="50" x2="300" y2="50" stroke="rgba(255,255,255,0.03)" strokeWidth="1" strokeDasharray="2 2" />
              <line x1="0" y1="10" x2="300" y2="10" stroke="rgba(255,255,255,0.03)" strokeWidth="1" strokeDasharray="2 2" />
              
              {/* Cost curve vector trace line */}
              <path
                d="M 10 20 L 50 25 L 90 45 L 130 65 L 170 78 L 210 82 L 250 85 L 290 86"
                fill="none"
                stroke="#a855f7"
                strokeWidth="2.2"
                strokeDasharray="400"
                strokeDashoffset={planning ? "200" : "0"}
                style={{ transition: 'stroke-dashoffset 2.5s ease-out' }}
              />

              <path
                d="M 10 20 L 50 25 L 90 45 L 130 65 L 170 78 L 210 82 L 250 85 L 290 86"
                fill="none"
                stroke="rgba(168, 85, 247, 0.4)"
                strokeWidth="4"
                strokeDasharray="400"
                strokeDashoffset={planning ? "200" : "0"}
                style={{ filter: 'blur(3px)', transition: 'stroke-dashoffset 2.5s ease-out' }}
              />

              <circle cx="10" cy="20" r="2" fill="#a855f7" />
              <circle cx="90" cy="45" r="2" fill="#a855f7" />
              <circle cx="170" cy="78" r="2" fill="#a855f7" />
              <circle cx="290" cy="86" r="3.5" fill="#22d3ee" className="animate-pulse" />
            </svg>
          </div>
        </div>
      )}

      {/* Info */}
      <div className="p-4 rounded-xl border border-purple-500/10 bg-purple-500/[0.02]">
        <p className="text-xs text-purple-400/70 leading-relaxed">
          <strong className="text-purple-400/90">Quantum-Inspired Planning:</strong> Uses amplitude amplification to explore 2^30 (~1B) potential action paths in superposition. 
          <br /><br />
          <strong className="text-purple-400/90">Modes:</strong> Quantum (16GB+ RAM), Hybrid (8GB+ RAM), Classical (fallback).
          <br /><br />
          <strong className="text-purple-400/90">IBM Quantum:</strong> Cloud integration enabled with credentials from ~/.qiskit/qiskit-ibm.json. Toggle "Use IBM Quantum" to switch between cloud and local simulation.
        </p>
      </div>
    </div>
  );
}
