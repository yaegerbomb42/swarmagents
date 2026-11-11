// SelfImproveDetail.tsx - Dynamic LoRA Benchmark UI
'use client';

import { useState } from 'react';

export default function SelfImproveDetail() {
  const [batchSize, setBatchSize] = useState(8);
  const [loraRank, setLoraRank] = useState(4);
  const [device, setDevice] = useState('CPU');
  const [forwardLatency, setForwardLatency] = useState('—');
  const [backwardLatency, setBackwardLatency] = useState('—');
  const [vramUsage, setVramUsage] = useState('—');

  const runBenchmark = () => {
    // Placeholder simulation logic – replace with real benchmark calls
    const fLatency = (Math.random() * 200 + 50).toFixed(1);
    const bLatency = (Math.random() * 300 + 100).toFixed(1);
    const vram = (Math.random() * 8 + 2).toFixed(1) + ' GB';
    setForwardLatency(`${fLatency} ms`);
    setBackwardLatency(`${bLatency} ms`);
    setVramUsage(vram);
  };

  return (
    <div className="h-full flex flex-col bg-black/20 rounded-xl border border-white/[0.06] backdrop-blur-lg overflow-hidden p-4 animate-fade-in">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <span className="text-sm">⚡</span>
        <span className="text-sm font-medium text-white/80">Self‑Improve (Dynamic LoRA)</span>
      </div>
      <div className="flex-1 flex flex-col gap-4 p-4 overflow-auto">
        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-white/60 mb-1">Batch Size</label>
            <input
              type="range"
              min="1"
              max="32"
              value={batchSize}
              onChange={(e) => setBatchSize(parseInt(e.target.value))}
              className="w-full"
            />
            <div className="text-center text-sm text-white/80 mt-1">{batchSize}</div>
          </div>
          <div>
            <label className="block text-sm text-white/60 mb-1">LoRA Rank</label>
            <select
              value={loraRank}
              onChange={(e) => setLoraRank(parseInt(e.target.value))}
              className="w-full bg-black/30 text-white rounded"
            >
              <option value={4}>4</option>
              <option value={8}>8</option>
              <option value={16}>16</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-white/60 mb-1">Device</label>
            <select
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              className="w-full bg-black/30 text-white rounded"
            >
              <option>CPU</option>
              <option>Apple Silicon MPS</option>
              <option>CUDA</option>
            </select>
          </div>
        </div>
        {/* Run button */}
        <button
          onClick={runBenchmark}
          className="self-start px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded shadow hover:opacity-90 transition-opacity duration-200"
        >
          Run Benchmark
        </button>
        {/* Results */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
          <div className="p-4 bg-black/30 rounded backdrop-blur-sm">
            <h3 className="text-sm text-white/70 mb-1">Forward Pass</h3>
            <p className="text-lg font-mono text-white">{forwardLatency}</p>
          </div>
          <div className="p-4 bg-black/30 rounded backdrop-blur-sm">
            <h3 className="text-sm text-white/70 mb-1">Backward Pass</h3>
            <p className="text-lg font-mono text-white">{backwardLatency}</p>
          </div>
          <div className="p-4 bg-black/30 rounded backdrop-blur-sm">
            <h3 className="text-sm text-white/70 mb-1">VRAM Usage</h3>
            <p className="text-lg font-mono text-white">{vramUsage}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
