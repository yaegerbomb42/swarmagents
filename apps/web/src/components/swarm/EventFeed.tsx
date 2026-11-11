"use client";

import { Activity, X, Wifi, WifiOff, Cpu, Users, GitMerge, Zap, UserCheck } from "lucide-react";
import { useEventStream } from "@/hooks/useEventStream";

const typeIcons: Record<string, any> = {
  orchestrator: Zap,
  task: Cpu,
  agent: Users,
  team: GitMerge,
  profile: UserCheck,
  system: Activity,
};

const typeColors: Record<string, string> = {
  orchestrator: "text-amber-400/60",
  task: "text-cyan-400/60",
  agent: "text-violet-400/60",
  team: "text-emerald-400/60",
  profile: "text-pink-400/60",
  system: "text-white/30",
};

export default function EventFeed() {
  const { events, connected, clearEvents } = useEventStream();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={14} className={connected ? "text-emerald-400/60" : "text-red-400/60"} />
          <span className="text-[11px] uppercase tracking-wider text-white/30">
            Live Events
          </span>
          {connected ? (
            <Wifi size={12} className="text-emerald-400/50" />
          ) : (
            <WifiOff size={12} className="text-red-400/50" />
          )}
        </div>
        {events.length > 0 && (
          <button
            onClick={clearEvents}
            className="text-white/20 hover:text-white/40 transition"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
        {events.length === 0 && (
          <div className="text-center py-6 text-[11px] text-white/20">
            No events yet. Submit a task or form a team to see real-time updates.
          </div>
        )}
        {events.map((evt) => {
          const Icon = typeIcons[evt.type] || Activity;
          const color = typeColors[evt.type] || "text-white/30";
          return (
            <div
              key={evt.id}
              className="flex items-start gap-2 rounded bg-white/[0.02] p-2 hover:bg-white/[0.04] transition"
            >
              <Icon size={12} className={`mt-0.5 ${color}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase text-white/30">{evt.type}</span>
                  <span className="text-[10px] text-white/40">{evt.action}</span>
                </div>
                {Object.entries(evt.payload).slice(0, 3).map(([k, v]) => (
                  <div key={k} className="text-[10px] text-white/25 truncate">
                    {k}: {String(v).slice(0, 60)}
                  </div>
                ))}
              </div>
              <span className="text-[9px] text-white/15 whitespace-nowrap">
                {new Date(evt.timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
