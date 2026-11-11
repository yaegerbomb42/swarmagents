"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Wrench, Network, Dna, Users, MessageCircle, Sparkles, Rocket } from "lucide-react";
import ConsoleShell from "@/components/ConsoleShell";
import RequireAuth from "@/components/auth/RequireAuth";
import { readActiveDecompSessionId } from "@/lib/decompPersistence";
import AgentRolesCatalog from "@/components/AgentRolesCatalog";
import FleetOrchestratorBar from "@/components/fleet/FleetOrchestratorBar";

const SwarmLabMaster = dynamic(() => import("@/components/lab/SwarmLabMaster"), { ssr: false });
const SwarmHierarchyPanel = dynamic(() => import("@/components/swarm/SwarmHierarchyPanel"), { ssr: false });
const WorkerHeatmap = dynamic(() => import("@/components/fleet/WorkerHeatmap"), { ssr: false });
const PromptGeneticsLab = dynamic(() => import("@/components/swarm/PromptGeneticsLab"), { ssr: false });
const AgentGroupChat = dynamic(() => import("@/components/swarm/AgentGroupChat"), { ssr: false });
const SwarmCanvas = dynamic(() => import("@/components/swarm/SwarmCanvas"), { ssr: false });
const ConsensusReplay = dynamic(() => import("@/components/swarm/ConsensusReplay"), { ssr: false });
const MissionControl = dynamic(() => import("@/components/mission/MissionControl"), { ssr: false });

type ViewId = "mission" | "lab" | "map" | "chat" | "swarm" | "roles";

const VIEWS: { id: ViewId; label: string; icon: React.ElementType; badge?: string }[] = [
  { id: "mission", label: "Mission Control", icon: Rocket, badge: "LAUNCH" },
  { id: "lab", label: "Agent Studio", icon: Wrench },
  { id: "map", label: "Swarm Hierarchy", icon: Network },
  { id: "chat", label: "Groupchat", icon: MessageCircle },
  { id: "swarm", label: "Tuning & Genetics", icon: Dna },
  { id: "roles", label: "Fleet Roles", icon: Users },
];

export default function FleetPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<div className="p-8 text-sm text-zinc-500">Loading fleet…</div>}>
        <FleetPageInner />
      </Suspense>
    </RequireAuth>
  );
}

function FleetPageInner() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialView: ViewId =
    tabParam === "mission" || tabParam === "lab" || tabParam === "map" || tabParam === "chat" || tabParam === "swarm" || tabParam === "roles"
      ? tabParam
      : "mission";
  const [view, setView] = useState<ViewId>(initialView);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    setSessionId(readActiveDecompSessionId());
    const id = setInterval(() => setSessionId(readActiveDecompSessionId()), 4000);
    return () => clearInterval(id);
  }, []);

  const viewToggles = (
    <div className="flex items-center gap-1 overflow-x-auto max-w-[min(100%,28rem)]">
      {VIEWS.map((v) => {
        const Icon = v.icon;
        const on = view === v.id;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition ${
              on
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{v.label}</span>
            {v.badge && (
              <span className="text-[9px] font-mono px-1 rounded bg-cyan-950 text-cyan-400 border border-cyan-500/30">
                {v.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <ConsoleShell trailing={viewToggles}>
        <main className="flex-1 min-h-0 p-3 flex flex-col">
          <FleetOrchestratorBar />
          <p className="text-[10px] text-zinc-500 px-1 pb-2 shrink-0">
            Swarm lab · visual no-code studio, global agent marketplace & live handoff inspector
          </p>
          <div className="flex-1 min-h-0 rounded-xl border border-white/[0.04] bg-[#06061a] overflow-hidden flex flex-col">
            <Suspense fallback={<div className="p-8 text-sm text-zinc-500">Loading lab studio…</div>}>
              {view === "mission" && (
                <div className="h-full p-3 min-h-0 overflow-y-auto">
                  <MissionControl className="h-full" />
                </div>
              )}
              {view === "lab" && <SwarmLabMaster />}
              {view === "map" && (
                <div className="h-full flex flex-col min-h-0">
                  <div className="shrink-0 p-2">
                    <WorkerHeatmap />
                  </div>
                  <div className="flex-1 min-h-0">
                    <SwarmHierarchyPanel />
                  </div>
                </div>
              )}
              {view === "chat" && (
                <div className="h-full m-2 flex flex-col gap-3 min-h-0">
                  <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3">
                    <SwarmCanvas sessionId={sessionId} className="flex-1 min-h-[240px]" />
                    <AgentGroupChat sessionId={sessionId} className="flex-1 min-h-0" />
                  </div>
                  <ConsensusReplay className="shrink-0 max-h-80" />
                </div>
              )}
              {view === "swarm" && <PromptGeneticsLab embedded />}
              {view === "roles" && (
                <div className="h-full overflow-y-auto p-4 bg-[#080811]">
                  <AgentRolesCatalog />
                </div>
              )}
            </Suspense>
          </div>
        </main>
      </ConsoleShell>
  );
}
