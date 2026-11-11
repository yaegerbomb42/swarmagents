'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Atom, 
  Activity, 
  Zap, 
  TrendingUp, 
  Settings, 
  Play, 
  Pause,
  ChevronDown,
  ChevronRight
} from 'lucide-react';

interface QuantumStatus {
  status: 'idle' | 'running' | 'paused' | 'error';
  energy: number;
  temperature: number;
  iterations: number;
  convergence: number;
  provider: string;
}

export default function QuantumOptimizationPanel() {
  const [status, setStatus] = useState<QuantumStatus>({
    status: 'idle',
    energy: 0,
    temperature: 1.0,
    iterations: 0,
    convergence: 0,
    provider: 'auto'
  });
  const [expanded, setExpanded] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Fetch status from API
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/quantum');
        const data = await response.json();
        setStatus(data);
      } catch (error) {
        console.error('Failed to fetch quantum status:', error);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);

    return () => clearInterval(interval);
  }, []);

  // Waveform animation loop (Prompt 16)
  useEffect(() => {
    if (!expanded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let phase = 0;

    const renderWave = () => {
      if (!canvas || !ctx) return;
      const width = (canvas.width = canvas.offsetWidth || 300);
      const height = (canvas.height = canvas.offsetHeight || 48);

      ctx.clearRect(0, 0, width, height);

      const isRunning = status.status === 'running';
      const temp = status.temperature;
      
      let frequency = isRunning ? (temp * 3.5 + 0.5) : 0.5;
      let amplitude = isRunning ? (temp * 12 + 1) : 0.8;
      
      if (status.status === 'idle') {
        frequency = 0.4;
        amplitude = 0.5;
      }

      ctx.beginPath();
      ctx.strokeStyle = isRunning ? '#06b6d4' : 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = isRunning ? '#06b6d4' : 'transparent';
      ctx.shadowBlur = isRunning ? 4 : 0;

      for (let x = 0; x < width; x++) {
        const y = height / 2 + Math.sin(x * (frequency / 60) + phase) * amplitude;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.shadowBlur = 0; // Reset shadow
      ctx.beginPath();
      ctx.strokeStyle = isRunning ? 'rgba(168, 85, 247, 0.4)' : 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x++) {
        const y = height / 2 + Math.sin(x * (frequency / 60) - phase + Math.PI / 2) * (amplitude * 0.5);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      phase += isRunning ? 0.07 : 0.015;
      animId = requestAnimationFrame(renderWave);
    };

    renderWave();
    return () => {
      cancelAnimationFrame(animId);
    };
  }, [expanded, status.status, status.temperature]);

  const handleToggle = async () => {
    const action = status.status === 'running' ? 'pause' : 'start';
    try {
      const response = await fetch('/api/quantum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (response.ok) {
        const data = await response.json();
        setStatus(prev => ({
          ...prev,
          status: action === 'start' ? 'running' : 'paused'
        }));
      }
    } catch (error) {
      console.error('Failed to toggle optimization:', error);
    }
  };

  const handleReset = async () => {
    try {
      const response = await fetch('/api/quantum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' })
      });
      if (response.ok) {
        setStatus({
          status: 'idle',
          energy: 0,
          temperature: 1.0,
          iterations: 0,
          convergence: 0,
          provider: 'auto'
        });
      }
    } catch (error) {
      console.error('Failed to reset optimization:', error);
    }
  };

  const statusColors = {
    idle: 'bg-white/20 shadow-[0_0_8px_rgba(255,255,255,0.2)]',
    running: 'bg-cyan-500 shadow-[0_0_12px_rgba(6,182,212,0.6)] animate-pulse',
    paused: 'bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.6)]',
    error: 'bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.6)]'
  };

  return (
    <div className="border-b border-white/[0.05] bg-transparent">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${statusColors[status.status]}`} />
          <Atom size={18} className="text-cyan-400" />
          <span className="font-semibold text-sm text-white/80 tracking-wide">Quantum Optimization</span>
        </div>
        {expanded ? <ChevronDown size={16} className="text-white/30" /> : <ChevronRight size={16} className="text-white/30" />}
      </button>

      {expanded && (
        <div className="p-4 pt-0 space-y-4">
          {/* Status Metrics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/30 mb-1">
                <Activity size={10} className="text-cyan-400/60" />
                Energy
              </div>
              <div className="text-base font-bold font-mono text-cyan-300">
                {status.energy.toFixed(4)}
              </div>
            </div>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/30 mb-1">
                <Zap size={10} className="text-purple-400/60" />
                Temperature
              </div>
              <div className="text-base font-bold font-mono text-purple-300">
                {status.temperature.toFixed(3)}
              </div>
            </div>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/30 mb-1">
                <TrendingUp size={10} className="text-blue-400/60" />
                Iterations
              </div>
              <div className="text-base font-bold font-mono text-blue-300">
                {status.iterations}
              </div>
            </div>
            <div className="bg-white/[0.01] border border-white/[0.04] rounded-xl p-3">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/30 mb-1">
                <Activity size={10} className="text-emerald-400/60" />
                Convergence
              </div>
              <div className="text-base font-bold font-mono text-emerald-300">
                {(status.convergence * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Canvas Waveform Cooling Curves (Prompt 16) */}
          <div className="bg-black/60 rounded-xl border border-white/[0.04] p-2 overflow-hidden">
            <div className="text-[8px] font-mono uppercase tracking-[0.15em] text-white/30 mb-1.5 px-1 flex justify-between">
              <span>Waveform Convergence Output</span>
              <span className="text-cyan-400/80 animate-pulse">Live Stream</span>
            </div>
            <canvas ref={canvasRef} className="w-full h-12 block" />
          </div>
 
          {/* Provider Selection */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-white/40 mb-2 block">Provider Mode</label>
            <select
              value={status.provider}
              onChange={(e) => setStatus(prev => ({ ...prev, provider: e.target.value }))}
              className="w-full px-3 py-2 text-xs border border-white/10 rounded-lg bg-black/60 text-white/80 outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
            >
              <option value="auto" className="bg-black">Auto (Local → API → Baseline)</option>
              <option value="local" className="bg-black">Local (Ollama)</option>
              <option value="api" className="bg-black">API (Together/Fireworks)</option>
              <option value="baseline" className="bg-black">Baseline (No LoRA)</option>
            </select>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleToggle}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:shadow-lg hover:shadow-cyan-500/15 text-black text-xs font-bold tracking-wider uppercase rounded-lg transition-all"
            >
              {status.status === 'running' ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}
              {status.status === 'running' ? 'Pause' : 'Start'}
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-white/10 hover:bg-white/[0.04] text-white/70 hover:text-white text-xs font-bold tracking-wider uppercase rounded-lg transition-colors"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
