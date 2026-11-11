'use client';

import React, { useState, useEffect } from 'react';
import { 
  Globe, 
  Shield, 
  Activity, 
  Play, 
  Pause, 
  Settings,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle
} from 'lucide-react';

interface BrowserStatus {
  status: 'idle' | 'running' | 'paused' | 'error';
  cdpConnected: boolean;
  captchaSolver: boolean;
  currentProvider: string;
  tasksCompleted: number;
  currentTask: string;
}

export default function BrowserAutomationPanel() {
  const [status, setStatus] = useState<BrowserStatus>({
    status: 'idle',
    cdpConnected: false,
    captchaSolver: true,
    currentProvider: 'gemini_2_5',
    tasksCompleted: 0,
    currentTask: ''
  });
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // Fetch status from API
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/browser');
        const data = await response.json();
        setStatus(data);
      } catch (error) {
        console.error('Failed to fetch browser status:', error);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);

    return () => clearInterval(interval);
  }, []);

  const handleToggle = async () => {
    const action = status.status === 'running' ? 'pause' : 'start';
    try {
      const response = await fetch('/api/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (response.ok) {
        setStatus(prev => ({
          ...prev,
          status: action === 'start' ? 'running' : 'paused'
        }));
      }
    } catch (error) {
      console.error('Failed to toggle browser automation:', error);
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
          <Globe size={18} className="text-cyan-400" />
          <span className="font-semibold text-sm text-white/80 tracking-wide">Browser Automation (A.R.I.A.)</span>
        </div>
        {expanded ? <ChevronDown size={16} className="text-white/30" /> : <ChevronRight size={16} className="text-white/30" />}
      </button>

      {expanded && (
        <div className="p-4 pt-0 space-y-4">
          {/* Connection Status */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">CDP Connection</span>
              <div className="flex items-center gap-1">
                {status.cdpConnected ? (
                  <CheckCircle size={14} className="text-emerald-400" />
                ) : (
                  <XCircle size={14} className="text-red-400" />
                )}
                <span className={`text-xs font-semibold ${status.cdpConnected ? 'text-emerald-300' : 'text-red-300'}`}>
                  {status.cdpConnected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">CAPTCHA Solver</span>
              <div className="flex items-center gap-1">
                {status.captchaSolver ? (
                  <CheckCircle size={14} className="text-emerald-400" />
                ) : (
                  <XCircle size={14} className="text-red-400" />
                )}
                <span className={`text-xs font-semibold ${status.captchaSolver ? 'text-emerald-300' : 'text-red-300'}`}>
                  {status.captchaSolver ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
          </div>

          {/* Mock Browser Viewport (Prompt 17) */}
          <div className="bg-[#05050f] rounded-xl border border-white/[0.04] overflow-hidden shadow-2xl">
            {/* Address Bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-black/40 border-b border-white/[0.04] text-[10px] font-mono">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500/60" />
                <div className="w-1.5 h-1.5 rounded-full bg-yellow-500/60" />
                <div className="w-1.5 h-1.5 rounded-full bg-green-500/60" />
              </div>
              <div className="flex-1 bg-black/80 px-2 py-0.5 rounded border border-white/5 text-white/50 truncate select-all">
                {status.status === 'running' ? 'https://swarmagents.codes/mission/task_exec' : 'about:blank'}
              </div>
              {status.status === 'running' && (
                <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
              )}
            </div>

            {/* DOM Scanning Viewport */}
            <div className="relative h-24 bg-[#0a0a1f] flex flex-col justify-center items-center text-center p-3 overflow-hidden select-none">
              {status.status === 'running' ? (
                <>
                  {/* Glowing DOM Scan Overlay Line */}
                  <div className="absolute inset-x-0 h-0.5 bg-cyan-400/80 shadow-[0_0_10px_#00BFFF] animate-scan-line z-20" />
                  <div className="relative z-10 space-y-1">
                    <div className="text-[10px] font-mono text-cyan-300 font-semibold animate-pulse">
                      CDP ACTIVE: SCANNING DOM
                    </div>
                    <div className="text-[9px] font-mono text-white/40 truncate max-w-[220px]">
                      {status.currentTask || 'Locating target CSS selectors...'}
                    </div>
                    {/* Simulated DOM nodes */}
                    <div className="flex justify-center gap-1.5 text-[8px] font-mono text-white/20">
                      <span>&lt;div id="root"&gt;</span>
                      <span className="text-purple-400/50">&lt;button class="cta"&gt;</span>
                      <span>&lt;/div&gt;</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-[10px] font-mono text-white/20">
                  BROWSER PORT READY · IDLE
                </div>
              )}
            </div>
          </div>

          {/* Provider Selection */}
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-white/40 mb-2 block">LLM Provider</label>
            <select
              value={status.currentProvider}
              onChange={(e) => setStatus(prev => ({ ...prev, currentProvider: e.target.value }))}
              className="w-full px-3 py-2 text-xs border border-white/10 rounded-lg bg-black/60 text-white/80 outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20"
            >
              <option value="watsonx_vision" className="bg-black">Watsonx Vision (Priority 1)</option>
              <option value="watsonx_120b" className="bg-black">Watsonx 120B MoE (Priority 1)</option>
              <option value="gemini_2_5" className="bg-black">Gemini 2.5 Flash (Priority 2)</option>
              <option value="nvidia" className="bg-black">NVIDIA Llama 3.2 Vision (Priority 3)</option>
              <option value="groq" className="bg-black">Groq Llama 3.3 70B (Priority 4)</option>
              <option value="cerebras" className="bg-black">Cerebras Llama 3.1 8B (Priority 5)</option>
              <option value="openrouter" className="bg-black">OpenRouter (Fallback)</option>
            </select>
          </div>

          {/* Quick Actions */}
          <div className="grid grid-cols-2 gap-2">
            <button className="flex items-center justify-center gap-2 px-3 py-2 bg-white/[0.02] border border-white/10 hover:bg-white/[0.06] text-white/80 text-xs font-semibold tracking-wide rounded-lg transition-colors">
              <Globe size={12} className="text-cyan-400" />
              Fill Form
            </button>
            <button className="flex items-center justify-center gap-2 px-3 py-2 bg-white/[0.02] border border-white/10 hover:bg-white/[0.06] text-white/80 text-xs font-semibold tracking-wide rounded-lg transition-colors">
              <Shield size={12} className="text-purple-400" />
              Login
            </button>
            <button className="flex items-center justify-center gap-2 px-3 py-2 bg-white/[0.02] border border-white/10 hover:bg-white/[0.06] text-white/80 text-xs font-semibold tracking-wide rounded-lg transition-colors">
              <Activity size={12} className="text-emerald-400" />
              Scrape Data
            </button>
            <button className="flex items-center justify-center gap-2 px-3 py-2 bg-white/[0.02] border border-white/10 hover:bg-white/[0.06] text-white/80 text-xs font-semibold tracking-wide rounded-lg transition-colors">
              <Settings size={12} className="text-blue-400" />
              Settings
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleToggle}
              disabled={!status.cdpConnected}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:shadow-lg hover:shadow-cyan-500/15 disabled:from-white/5 disabled:to-white/5 disabled:text-white/20 disabled:cursor-not-allowed text-black text-xs font-bold tracking-wider uppercase rounded-lg transition-all"
            >
              {status.status === 'running' ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}
              {status.status === 'running' ? 'Pause' : 'Start'}
            </button>
          </div>

          {!status.cdpConnected && (
            <div className="p-3 bg-yellow-950/[0.08] border border-yellow-500/20 rounded-lg">
              <p className="text-xs text-yellow-300/80 leading-relaxed">
                Chrome CDP not connected. Start Chrome with: <code className="bg-black/40 px-1 py-0.5 rounded text-cyan-300 font-mono">--remote-debugging-port=9222</code>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
