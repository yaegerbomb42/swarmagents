"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InnerWorldGrid, { type DensityMode } from "@/components/swarm/InnerWorldGrid";
import { agentStreamStore, type AgentEvent } from "@/lib/agentStreamStore";
import { Activity, Pause, Play, RefreshCw } from "lucide-react";
import RequireAuth from "@/components/auth/RequireAuth";

type SourceMode = "off" | "synth" | "live";

interface Stats {
  agents: number;
  ingested: number;
  evtPerSec: number;
  heapMB: number | null;
}

export default function InnerWorldPage() {
  return (
    <RequireAuth>
      <InnerWorldContent />
    </RequireAuth>
  );
}

function InnerWorldContent() {
  const [source, setSource] = useState<SourceMode>("off");
  const [agentCount, setAgentCount] = useState(500);
  const [rate, setRate] = useState(5);
  const [density, setDensity] = useState<DensityMode>("compact");
  const [filter, setFilter] = useState("");
  const [stats, setStats] = useState<Stats>({ agents: 0, ingested: 0, evtPerSec: 0, heapMB: null });

  const esRef = useRef<EventSource | null>(null);
  const ingestedRef = useRef(0);
  const lastWindowRef = useRef<{ t: number; n: number }>({ t: Date.now(), n: 0 });

  const stopStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const startStream = useCallback(
    (mode: SourceMode) => {
      stopStream();
      agentStreamStore.clear();
      ingestedRef.current = 0;
      if (mode === "off") return;
      const url =
        mode === "synth"
          ? `/api/events/synth?agents=${agentCount}&rate=${rate}`
          : `/api/events`;
      const es = new EventSource(url);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const raw = JSON.parse(e.data);
          // Synth events already conform to AgentEvent shape.
          // Live: /api/events unwraps engine agent envelopes into
          // { id, agentId, type, payload, timestamp } — accept that shape
          // directly, else fall back to payload-inferred agentId.
          if (mode === "synth") {
            agentStreamStore.ingest(raw as AgentEvent);
            ingestedRef.current += 1;
          } else {
            const agentId =
              (typeof raw.agentId === "string" && raw.agentId) ||
              (typeof raw.payload?.agentId === "string" && raw.payload.agentId) ||
              (typeof raw.payload?.agent_id === "string" && raw.payload.agent_id);
            const isAgentType = ["thought", "tool_call", "tool_result", "memory", "state", "error"].includes(
              raw.type
            );
            if (agentId && raw.type && isAgentType) {
              // Normalize timestamp: engine may send seconds or ms.
              const ts =
                typeof raw.timestamp === "number"
                  ? raw.timestamp > 1e12
                    ? raw.timestamp
                    : raw.timestamp * 1000
                  : Date.now();
              const payload =
                raw.payload && typeof raw.payload === "object" && !("agentId" in raw.payload)
                  ? { ...raw.payload }
                  : (raw.payload ?? {});
              const evt: AgentEvent = {
                id: raw.id ?? `evt-${Date.now()}`,
                agentId,
                type: raw.type as AgentEvent["type"],
                payload,
                timestamp: ts,
              };
              agentStreamStore.ingest(evt);
              ingestedRef.current += 1;
            }
          }
        } catch {
          /* malformed */
        }
      };
    },
    [agentCount, rate, stopStream]
  );

  useEffect(() => {
    if (source !== "off") startStream(source);
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Stats ticker
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastWindowRef.current.t) / 1000;
      const n = ingestedRef.current;
      const evtPerSec = dt > 0 ? Math.round((n - lastWindowRef.current.n) / dt) : 0;
      lastWindowRef.current = { t: now, n };
      let heapMB: number | null = null;
      const p = performance as unknown as { memory?: { usedJSHeapSize: number } };
      if (p.memory?.usedJSHeapSize) heapMB = Math.round(p.memory.usedJSHeapSize / 1048576);
      setStats({
        agents: agentStreamStore.size(),
        ingested: n,
        evtPerSec,
        heapMB,
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-[#07070b] text-white">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <Activity size={16} className="text-violet-400" />
          <h1 className="text-sm font-semibold tracking-wide">Inner World</h1>
          <span className="text-[10px] uppercase tracking-wider text-white/30">
            agent thought-grid
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as SourceMode)}
            className="rounded bg-white/5 px-2 py-1 text-white/70"
          >
            <option value="off">Off</option>
            <option value="synth">Synthetic</option>
            <option value="live">Live</option>
          </select>
          {source === "synth" && (
            <>
              <input
                type="number"
                value={agentCount}
                onChange={(e) => setAgentCount(parseInt(e.target.value || "0", 10))}
                className="w-16 rounded bg-white/5 px-2 py-1 text-white/70"
                title="agents"
              />
              <input
                type="number"
                value={rate}
                onChange={(e) => setRate(parseFloat(e.target.value || "0"))}
                className="w-16 rounded bg-white/5 px-2 py-1 text-white/70"
                title="events/sec/agent"
              />
              <button
                onClick={() => startStream("synth")}
                className="rounded bg-white/5 p-1.5 hover:bg-white/10"
                title="Restart stream"
              >
                <RefreshCw size={12} />
              </button>
            </>
          )}
          <select
            value={density}
            onChange={(e) => setDensity(e.target.value as DensityMode)}
            className="rounded bg-white/5 px-2 py-1 text-white/70"
          >
            <option value="cozy">Cozy</option>
            <option value="compact">Compact</option>
            <option value="dense">Dense</option>
          </select>
          <input
            placeholder="filter agents…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-40 rounded bg-white/5 px-2 py-1 text-white/70 placeholder:text-white/25"
          />
        </div>
      </header>

      <div className="flex items-center gap-4 border-b border-white/5 px-4 py-1.5 text-[10px] font-mono text-white/40">
        <span>agents: {stats.agents}</span>
        <span>ingested: {stats.ingested.toLocaleString()}</span>
        <span>~{stats.evtPerSec} evt/s</span>
        {stats.heapMB !== null && <span>heap: {stats.heapMB} MB</span>}
        <span className="ml-auto">
          {source === "synth" && `${agentCount} agents × ${rate} ev/s target`}
        </span>
      </div>

      <main className="flex-1 overflow-hidden">
        <InnerWorldGrid density={density} filter={filter} />
      </main>
    </div>
  );
}
