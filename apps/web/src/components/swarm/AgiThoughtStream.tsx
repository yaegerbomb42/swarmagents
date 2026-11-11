'use client';

import React from 'react';

export default function AgiThoughtStream() {
  return (
    <div className="relative w-[360px] min-h-[640px] bg-[#0c0c16]/90 border border-white/[0.04] rounded-2xl flex flex-col items-center justify-start py-8 px-4 overflow-hidden shadow-2xl select-none">
      {/* ── Glowing Sub-Grid Background ── */}
      <div 
        className="absolute inset-0 opacity-[0.02] pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)
          `,
          backgroundSize: '24px 24px'
        }}
      />

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes pulse-brain {
          0%, 100% { transform: scale(1); filter: drop-shadow(0 0 6px rgba(59, 130, 246, 0.4)); }
          50% { transform: scale(1.08); filter: drop-shadow(0 0 16px rgba(59, 130, 246, 0.8)); }
        }
        @keyframes float-label {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes spin-arc-left {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(-360deg); }
        }
        @keyframes spin-arc-right {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .animate-brain {
          animation: pulse-brain 3s ease-in-out infinite;
        }
        .float-card {
          animation: float-label 4s ease-in-out infinite;
        }
      ` }} />

      {/* ── 1. Pulsing Brain Header ── */}
      <div className="relative z-10 w-16 h-16 rounded-full bg-blue-950/40 border border-blue-500/30 flex items-center justify-center animate-brain mb-10">
        <svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" className="w-8 h-8">
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1 0-3.12 3 3 0 0 1 0-4.88 2.5 2.5 0 0 1 0-3.12A2.5 2.5 0 0 1 9.5 2Z" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 0-3.12 3 3 0 0 0 0-4.88 2.5 2.5 0 0 0 0-3.12A2.5 2.5 0 0 0 14.5 2Z" />
        </svg>
      </div>

      {/* ── 2. Flow Diagram & Diamonds Stage ── */}
      <div className="relative w-full flex-1 flex flex-col items-center">
        
        {/* Connection Spine Line */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-gradient-to-b from-blue-500 via-purple-500 to-emerald-500 opacity-20" />

        {/* Dynamic Glowing Curves (Rotational Arcs) */}
        <div className="absolute top-[80px] left-8 w-24 h-24 border-l-2 border-t-2 border-blue-500/20 rounded-full animate-[spin-arc-left_12s_linear_infinite]" />
        <div className="absolute top-[160px] right-8 w-20 h-20 border-r-2 border-b-2 border-amber-500/20 rounded-full animate-[spin-arc-right_8s_linear_infinite]" />
        <div className="absolute top-[280px] left-4 w-28 h-28 border-l-2 border-b-2 border-purple-500/20 rounded-full animate-[spin-arc-left_16s_linear_infinite]" />

        {/* Vertical Diamond Cascade Nodes */}
        <div className="flex flex-col items-center space-y-12 w-full z-10">
          
          {/* Level 1: Input */}
          <div className="relative flex items-center justify-center w-full">
            <div className="w-10 h-10 rotate-45 border-2 border-blue-500/60 bg-blue-950/80 shadow-[0_0_12px_rgba(59,130,246,0.3)] flex items-center justify-center transition-all duration-300 hover:scale-110" />
            <div className="absolute left-[55%] ml-6 float-card bg-blue-950/70 border border-blue-500/30 px-3 py-1.5 rounded-lg backdrop-blur-md text-left min-w-[140px]">
              <div className="text-[9px] text-blue-400 font-mono tracking-wider uppercase">User Input</div>
              <div className="text-xs text-white/80 font-bold font-mono">DEFINE AGI CORE</div>
            </div>
          </div>

          {/* Level 2: Processing */}
          <div className="relative flex items-center justify-center w-full">
            <div className="w-10 h-10 rotate-45 border-2 border-amber-500/60 bg-amber-950/80 shadow-[0_0_12px_rgba(245,158,11,0.3)] flex items-center justify-center transition-all duration-300 hover:scale-110" />
            <div className="absolute right-[55%] mr-6 float-card bg-amber-950/70 border border-amber-500/30 px-3 py-1.5 rounded-lg backdrop-blur-md text-right min-w-[140px]">
              <div className="text-[9px] text-amber-400 font-mono tracking-wider uppercase">AGI Processing</div>
              <div className="text-xs text-white/80 font-bold font-mono">RECURSIVE DECAY</div>
            </div>
          </div>

          {/* Level 3: Thought Structure */}
          <div className="relative flex items-center justify-center w-full">
            <div className="w-10 h-10 rotate-45 border-2 border-purple-500/60 bg-purple-950/80 shadow-[0_0_12px_rgba(168,85,247,0.3)] flex items-center justify-center transition-all duration-300 hover:scale-110" />
            <div className="absolute left-[55%] ml-6 float-card bg-purple-950/70 border border-purple-500/30 px-3 py-1.5 rounded-lg backdrop-blur-md text-left min-w-[140px]">
              <div className="text-[9px] text-purple-400 font-mono tracking-wider uppercase">Thought Matrix</div>
              <div className="text-xs text-white/80 font-bold font-mono">MODEL SYNAPSE</div>
            </div>
          </div>

          {/* Level 4: Output */}
          <div className="relative flex items-center justify-center w-full">
            <div className="w-10 h-10 rotate-45 border-2 border-emerald-500/60 bg-emerald-950/80 shadow-[0_0_12px_rgba(34,197,94,0.3)] flex items-center justify-center transition-all duration-300 hover:scale-110" />
            <div className="absolute right-[55%] mr-6 float-card bg-emerald-950/70 border border-emerald-500/30 px-3 py-1.5 rounded-lg backdrop-blur-md text-right min-w-[140px]">
              <div className="text-[9px] text-emerald-400 font-mono tracking-wider uppercase">Response State</div>
              <div className="text-xs text-white/80 font-bold font-mono">SYSTEM AWARENESS</div>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
