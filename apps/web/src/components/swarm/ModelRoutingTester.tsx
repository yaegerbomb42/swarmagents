"use client";

import { useState } from "react";
import { Cpu, Route, ArrowRight, Loader2, CheckCircle, AlertTriangle } from "lucide-react";

interface RoutingResult {
  selected_model: string;
  confidence: number;
  complexity_score: number;
  routing_reason: string;
  estimated_tokens: number;
  complexity: string;
}

export default function ModelRoutingTester() {
  const [task, setTask] = useState("");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RoutingResult | null>(null);
  const [error, setError] = useState("");

  const testRouting = async () => {
    if (!task.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/yaeger/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          context: context || undefined,
          preferred_model: undefined,
          force_model: false,
        }),
      });

      const data = await res.json();
      if (data.ok && data.routing) {
        setResult(data.routing);
      } else {
        setError(data.error || "Routing failed");
      }
    } catch (e: any) {
      setError(e.message || "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const modelColors: Record<string, string> = {
    "swarmagent-core-16.9b": "text-cyan-300/70 border-cyan-500/20 bg-cyan-500/[0.03]",
    "swarmagent-router-16.9b": "text-blue-300/70 border-blue-500/20 bg-blue-500/[0.03]",
    "swarmagent-general-1.1b": "text-emerald-300/70 border-emerald-500/20 bg-emerald-500/[0.03]",
  };

  const modelLabels: Record<string, string> = {
    "swarmagent-core-16.9b": "Core (High Reasoning)",
    "swarmagent-router-16.9b": "Router (Medium Reasoning)",
    "swarmagent-general-1.1b": "General (Fast Execution)",
  };

  return (
    <div className="space-y-4">
      {/* Input */}
      <div className="rounded-lg border border-cyan-500/20 bg-black/30 p-4 space-y-3">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe a task to classify and route..."
          rows={3}
          className="w-full px-3 py-2 rounded bg-black/40 border border-white/10 text-[13px] text-white/70 focus:outline-none focus:border-cyan-400/40 resize-y"
        />
        <input
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Optional context (files, codebase, etc.)"
          className="w-full px-3 py-2 rounded bg-black/40 border border-white/10 text-[13px] text-white/70 focus:outline-none focus:border-cyan-400/40"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={testRouting}
            disabled={loading || !task.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Route size={14} />}
            {loading ? "Analyzing..." : "Analyze & Route"}
          </button>
          <span className="text-[11px] text-white/30">
            Pattern-based classifier with complexity scoring
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/[0.03] p-3 flex items-center gap-2 text-[12px] text-red-300/70">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="rounded-lg border border-white/[0.06] bg-black/20 p-4 space-y-3">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={14} className="text-emerald-400/60" />
            <span className="text-[12px] font-medium text-white/60">Routing Decision</span>
          </div>

          {/* Selected Model */}
          <div className={`rounded-lg border p-3 ${modelColors[result.selected_model] || "text-white/60 border-white/10 bg-white/[0.02]"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu size={14} />
                <span className="text-[14px] font-semibold">{modelLabels[result.selected_model] || result.selected_model}</span>
              </div>
              <span className="text-[11px] font-mono">{(result.confidence * 100).toFixed(0)}% confidence</span>
            </div>
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded bg-white/[0.02] p-2 text-center">
              <div className="text-[9px] uppercase text-white/25">Complexity</div>
              <div className="text-[14px] font-semibold text-white/70 capitalize">{result.complexity}</div>
            </div>
            <div className="rounded bg-white/[0.02] p-2 text-center">
              <div className="text-[9px] uppercase text-white/25">Score</div>
              <div className="text-[14px] font-semibold text-white/70">{(result.complexity_score * 100).toFixed(0)}%</div>
            </div>
            <div className="rounded bg-white/[0.02] p-2 text-center">
              <div className="text-[9px] uppercase text-white/25">Est. Tokens</div>
              <div className="text-[14px] font-semibold text-white/70">{result.estimated_tokens}</div>
            </div>
          </div>

          {/* Reason */}
          <div className="rounded bg-white/[0.02] p-2">
            <div className="text-[10px] uppercase text-white/25 mb-1">Reason</div>
            <div className="text-[12px] text-white/50">{result.routing_reason}</div>
          </div>

          {/* Architecture Visualization */}
          <div className="flex items-center justify-center gap-3 py-2">
            <div className="text-center">
              <div className="text-[10px] text-white/30 mb-1">Task Input</div>
              <div className="w-20 h-8 rounded border border-white/10 bg-white/[0.03] flex items-center justify-center text-[10px] text-white/30">User</div>
            </div>
            <ArrowRight size={16} className="text-cyan-400/30" />
            <div className="text-center">
              <div className="text-[10px] text-cyan-300/40 mb-1">Classify</div>
              <div className="w-24 h-10 rounded border border-cyan-500/20 bg-cyan-500/[0.05] flex items-center justify-center text-[10px] text-cyan-300/50">
                {result.complexity}
              </div>
            </div>
            <ArrowRight size={16} className="text-cyan-400/30" />
            <div className="text-center">
              <div className="text-[10px] text-emerald-300/40 mb-1">Route</div>
              <div className={`w-28 h-8 rounded border flex items-center justify-center text-[10px] ${modelColors[result.selected_model]}`}>
                {result.selected_model.replace("swarmagent-", "").replace("-16.9b", "").replace("-1.1b", "")}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
