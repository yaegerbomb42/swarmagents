"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  GitBranch,
  MessageSquare,
  Users,
  GraduationCap,
  Plus,
  Loader2,
  Download,
  Trash2,
  Zap,
  ArrowRight,
} from "lucide-react";
import ConsoleShell from "@/components/ConsoleShell";

interface MarketStats {
  total_agents: number;
  collective_agents: number;
  total_tasks: number;
  open_tasks: number;
}

interface Agent {
  id: string;
  name: string;
  owner_name?: string;
  tasks_completed: number;
  avg_score: number;
  in_collective: boolean;
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return res.json();
}

export default function SystemPage() {
  const [market, setMarket] = useState<MarketStats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [autopilot, setAutopilot] = useState<boolean>(false);
  const [learning, setLearning] = useState<{ stats: Record<string, unknown>; config: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [taskTitle, setTaskTitle] = useState("");

  const refresh = useCallback(async () => {
    const [statsRes, agentsRes, autoRes, learnRes] = await Promise.all([
      jsonFetch("/api/swarm-market/stats").catch(() => null),
      jsonFetch("/api/swarm-market/agents").catch(() => null),
      jsonFetch("/api/swarm-market/autopilot").catch(() => null),
      jsonFetch("/api/learning/stats").catch(() => null),
    ]);
    if (statsRes?.stats) setMarket(statsRes.stats);
    const list = agentsRes?.agents ?? agentsRes?.list ?? (Array.isArray(agentsRes) ? agentsRes : []);
    setAgents(list);
    if (autoRes) setAutopilot(Boolean(autoRes.enabled ?? autoRes.status?.enabled ?? autoRes.active));
    if (learnRes?.stats) setLearning({ stats: learnRes.stats, config: learnRes.config || {} });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createAgent = async () => {
    if (!agentName.trim() || busy) return;
    setBusy(true);
    try {
      await jsonFetch("/api/swarm-market/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agentName.trim(), owner_name: "You" }),
      });
      setAgentName("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const createTask = async () => {
    if (!taskTitle.trim() || busy) return;
    setBusy(true);
    try {
      await jsonFetch("/api/swarm-market/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: taskTitle.trim(), difficulty: 5, reward_points: 100 }),
      });
      setTaskTitle("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const joinCollective = async (id: string) => {
    setBusy(true);
    try {
      await jsonFetch("/api/swarm-market/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join_collective", agent_id: id }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleAutopilot = async () => {
    setBusy(true);
    try {
      await jsonFetch("/api/swarm-market/autopilot", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const clearLearning = async () => {
    if (!confirm("Clear all learning data?")) return;
    setBusy(true);
    try {
      await jsonFetch("/api/learning/clear", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsoleShell>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 flex-1 overflow-auto">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Control Center</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/55">
          Agent marketplace, collective, and learning — same console as Mission and Orchestrate.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard href="/decomp" icon={GitBranch} title="Mission" desc="Time-budget tree and workspace." />
          <FeatureCard href="/chat" icon={MessageSquare} title="Chat" desc="Plan with the architect." />
          <FeatureCard href="#marketplace" icon={Users} title="Agent Market" desc="Create agents and post tasks." />
          <FeatureCard href="#learning" icon={GraduationCap} title="Learning" desc="Training samples the swarm collects." />
        </div>

        <section id="marketplace" className="mt-10 scroll-mt-20">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Agent Marketplace</h2>
            <button
              onClick={toggleAutopilot}
              disabled={busy}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                autopilot ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/10 text-white/60 hover:bg-white/5"
              }`}
            >
              <Zap className="h-4 w-4" />
              Autopilot {autopilot ? "On" : "Off"}
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Agents" value={market?.total_agents ?? 0} />
            <StatTile label="In Collective" value={market?.collective_agents ?? 0} />
            <StatTile label="Tasks" value={market?.total_tasks ?? 0} />
            <StatTile label="Open Tasks" value={market?.open_tasks ?? 0} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200/70">Agents</h3>
              {agents.length === 0 ? (
                <p className="text-sm text-white/45">No agents yet — create one to get started.</p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {agents.map((a) => (
                    <li key={a.id} className="flex items-center justify-between py-2.5">
                      <div>
                        <div className="text-sm font-medium">{a.name}</div>
                        <div className="text-xs text-white/40">
                          {a.owner_name || "User"} · {a.tasks_completed} tasks · score {Number(a.avg_score).toFixed(2)}
                        </div>
                      </div>
                      {a.in_collective ? (
                        <span className="rounded-full bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-200">Collective</span>
                      ) : (
                        <button
                          onClick={() => joinCollective(a.id)}
                          disabled={busy}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-white/60 hover:bg-white/5"
                        >
                          Join
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200/70">New agent</h3>
                <input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createAgent()}
                  placeholder="Agent name"
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-cyan-400/50"
                />
                <button
                  onClick={createAgent}
                  disabled={!agentName.trim() || busy}
                  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-teal-400 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create agent
                </button>
              </div>

              <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200/70">Post task</h3>
                <input
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createTask()}
                  placeholder="Task title"
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-cyan-400/50"
                />
                <button
                  onClick={createTask}
                  disabled={!taskTitle.trim() || busy}
                  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/5 disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                  Post task
                </button>
              </div>
            </div>
          </div>
        </section>

        <section id="learning" className="mt-10 scroll-mt-20">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Learning System</h2>
            <div className="flex items-center gap-2">
              <a
                href="/api/learning/export"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/60 hover:bg-white/5"
              >
                <Download className="h-4 w-4" /> Export
              </a>
              <button
                onClick={clearLearning}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 px-3 py-1.5 text-sm text-red-300/80 hover:bg-red-500/10"
              >
                <Trash2 className="h-4 w-4" /> Clear
              </button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {learning
              ? Object.entries(learning.stats)
                  .filter(([, v]) => typeof v === "number" || typeof v === "string")
                  .slice(0, 8)
                  .map(([k, v]) => <StatTile key={k} label={k.replace(/([A-Z])/g, " $1")} value={v as number} />)
              : Array.from({ length: 4 }).map((_, i) => <StatTile key={i} label="…" value={0} />)}
          </div>
        </section>
      </div>
    </ConsoleShell>
  );
}

function FeatureCard({ href, icon: Icon, title, desc }: { href: string; icon: React.ElementType; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 transition-all hover:-translate-y-0.5 hover:border-cyan-400/25 hover:bg-cyan-400/[0.04]"
    >
      <Icon className="mb-3 h-6 w-6 text-cyan-300" />
      <div className="flex items-center gap-1.5 text-sm font-semibold text-white/90">
        {title}
        <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-1 text-xs leading-relaxed text-white/55">{desc}</div>
    </Link>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.03] p-4">
      <div className="text-xs font-mono uppercase tracking-[0.15em] text-cyan-100/50">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}
