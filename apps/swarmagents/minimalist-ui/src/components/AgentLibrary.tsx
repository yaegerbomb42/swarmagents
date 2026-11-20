"use client";

/**
 * The Agent Studio surface (phase 6): browse the caller's agents, search them,
 * open the builder, deploy, clone, export, import, delete, and roll back through
 * version history.
 *
 * Team agents and community templates are deliberately empty sections with a
 * note — v1 has no data behind them and fake rows would be worse than a gap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Download,
  History,
  Loader2,
  Plus,
  Rocket,
  Search,
  Trash2,
  Undo2,
  Upload,
  Users,
} from "lucide-react";
import {
  agentsApi,
  AgentApiError,
  type AgentHistoryRow,
  type AgentManifest,
  type AgentSummary,
} from "../../../lib/client/agents";
import { filterAgents } from "./agentForm";
import { AgentStudio } from "./AgentStudio";

function errorText(err: unknown): string {
  if (err instanceof AgentApiError) {
    const missing = err.details.missing?.length ? ` Missing: ${err.details.missing.join("; ")}` : "";
    const errors = err.details.errors?.length ? ` ${err.details.errors.join("; ")}` : "";
    return `${err.message}${errors}${missing}`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

function when(epochMs: number): string {
  if (!epochMs) return "—";
  const delta = Date.now() - epochMs;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleDateString();
}

export function AgentLibrary() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // null = list, "" = new agent
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<AgentHistoryRow[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await agentsApi.list();
      setAgents(result.agents);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => filterAgents(agents, query), [agents, query]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function cloneAgent(id: string) {
    await withBusy(async () => {
      const result = await agentsApi.clone(id);
      setNotice(`Cloned as ${result.agent.name}.`);
      await refresh();
    });
  }

  async function exportAgent(id: string) {
    await withBusy(async () => {
      const pkg = await agentsApi.exportPackage(id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${pkg.agent.id}.swarm-agent.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`Exported ${pkg.agent.id}.`);
    });
  }

  async function removeAgent(id: string) {
    await withBusy(async () => {
      await agentsApi.remove(id);
      setNotice(`Deleted ${id}.`);
      if (historyFor === id) setHistoryFor(null);
      await refresh();
    });
  }

  async function deployAgent(id: string) {
    await withBusy(async () => {
      const result = await agentsApi.deploy(id, "swarm");
      setNotice(`Deployed ${id} as run ${result.runId}.`);
    });
  }

  async function openHistory(id: string) {
    if (historyFor === id) {
      setHistoryFor(null);
      return;
    }
    await withBusy(async () => {
      const result = await agentsApi.history(id);
      setHistory(result.history);
      setHistoryFor(id);
    });
  }

  async function restore(id: string, versionIndex: number) {
    await withBusy(async () => {
      await agentsApi.restore(id, versionIndex);
      setNotice(`Restored version ${versionIndex + 1} of ${id}.`);
      const result = await agentsApi.history(id);
      setHistory(result.history);
      await refresh();
    });
  }

  async function onImportFile(file: File) {
    await withBusy(async () => {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const result = await agentsApi.importPackage(parsed);
      setNotice(
        result.warnings.length > 0
          ? `Imported ${result.agent.name} with warnings: ${result.warnings.join("; ")}`
          : `Imported ${result.agent.name}.`,
      );
      await refresh();
    });
  }

  if (editing !== null) {
    return (
      <AgentStudio
        agentId={editing || undefined}
        onSaved={() => {
          void refresh();
        }}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#08080c] text-zinc-200" data-testid="agent-library">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.07] px-2 py-1.5">
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold">
          <Bot className="h-3.5 w-3.5 text-cyan-300" aria-hidden /> Agents
        </h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/[0.06]"
        >
          <Upload className="h-3 w-3" aria-hidden /> Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onImportFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => setEditing("")}
          className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/15"
        >
          <Plus className="h-3 w-3" aria-hidden /> New agent
        </button>
      </div>

      {error ? (
        <div role="alert" className="flex items-start gap-2 border-b border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-300/70 hover:text-red-100">Dismiss</button>
        </div>
      ) : null}
      {notice ? (
        <div className="flex items-start gap-2 border-b border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-[11px] text-emerald-200">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-emerald-300/70 hover:text-emerald-100">Dismiss</button>
        </div>
      ) : null}

      <div className="sa-scroll min-h-0 flex-1 overflow-y-auto p-3">
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-zinc-500" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents by name or description"
            className="w-full rounded-md border border-white/10 bg-black/30 py-1.5 pl-7 pr-2 text-[12px] outline-none placeholder:text-zinc-600 focus:border-cyan-400/50"
          />
        </label>

        <section className="mt-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Personal agents</h3>
          {busy && visible.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading…
            </p>
          ) : null}
          {!busy && visible.length === 0 ? (
            <p className="mt-2 text-[11px] text-zinc-500">
              {agents.length === 0 ? "No agents yet. Create one, or import a package." : "No agent matches that search."}
            </p>
          ) : null}
          <ul className="mt-2 space-y-1.5">
            {visible.map((agent) => (
              <li key={agent.id} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">{agent.name}</p>
                    <p className="truncate text-[11px] text-zinc-500">{agent.description ?? "No description"}</p>
                    <p className="mt-0.5 text-[10px] text-zinc-600">
                      {agent.id} · v{agent.version} · updated {when(agent.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(agent.id)}
                      className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/[0.06]"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void deployAgent(agent.id)}
                      className="inline-flex items-center gap-0.5 rounded-md border border-cyan-400/30 px-1.5 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-400/10"
                    >
                      <Rocket className="h-2.5 w-2.5" aria-hidden /> Deploy
                    </button>
                    <button
                      type="button"
                      onClick={() => void cloneAgent(agent.id)}
                      aria-label={`Clone ${agent.name}`}
                      className="rounded-md border border-white/10 p-1 text-zinc-400 hover:bg-white/[0.06]"
                    >
                      <Copy className="h-2.5 w-2.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void exportAgent(agent.id)}
                      aria-label={`Export ${agent.name}`}
                      className="rounded-md border border-white/10 p-1 text-zinc-400 hover:bg-white/[0.06]"
                    >
                      <Download className="h-2.5 w-2.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void openHistory(agent.id)}
                      aria-label={`Version history for ${agent.name}`}
                      className="rounded-md border border-white/10 p-1 text-zinc-400 hover:bg-white/[0.06]"
                    >
                      <History className="h-2.5 w-2.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeAgent(agent.id)}
                      aria-label={`Delete ${agent.name}`}
                      className="rounded-md border border-white/10 p-1 text-zinc-400 hover:bg-red-400/10 hover:text-red-300"
                    >
                      <Trash2 className="h-2.5 w-2.5" aria-hidden />
                    </button>
                  </div>
                </div>
                {historyFor === agent.id ? (
                  <div className="mt-2 rounded-md border border-white/[0.06] bg-black/20 p-2" data-testid="agent-history">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Version history</p>
                    {history.length === 0 ? (
                      <p className="mt-1 text-[11px] text-zinc-600">No earlier versions.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {history.map((row) => (
                          <li key={row.versionIndex} className="flex items-center gap-2 text-[11px] text-zinc-400">
                            <span className="flex-1 truncate">
                              #{row.versionIndex + 1} · {row.name} · {row.models.preferred} · {when(row.savedAt)}
                            </span>
                            <button
                              type="button"
                              onClick={() => void restore(agent.id, row.versionIndex)}
                              className="inline-flex items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/[0.06]"
                            >
                              <Undo2 className="h-2.5 w-2.5" aria-hidden /> Restore
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-4 rounded-lg border border-white/[0.07] bg-white/[0.015] p-2">
          <h3 className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            <Users className="h-3 w-3" aria-hidden /> Team agents
          </h3>
          <p className="mt-1 text-[11px] text-zinc-600">
            Shared team agents are not available in this build. Nothing is listed here yet — this is not an empty
            account.
          </p>
        </section>

        <section className="mt-2 rounded-lg border border-white/[0.07] bg-white/[0.015] p-2">
          <h3 className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            <Bot className="h-3 w-3" aria-hidden /> Community templates
          </h3>
          <p className="mt-1 text-[11px] text-zinc-600">
            The template gallery ships with the community catalog, which is not part of this release.
          </p>
        </section>
      </div>
    </div>
  );
}
