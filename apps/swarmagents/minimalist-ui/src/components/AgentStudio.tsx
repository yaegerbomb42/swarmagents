"use client";

/**
 * The visual Agent Builder (phase 6).
 *
 * One form for one agent: identity, models, tools, MCP servers, connectors,
 * context, skills, memory, permissions and subagents — plus the two buttons
 * that matter before a deploy: "Check compatibility" (shows what this harness
 * can and cannot run) and "Deploy" (starts the run or lists what is missing).
 *
 * Every decision that can be wrong lives in `agentForm.ts` so it is unit
 * tested; this file only renders it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Rocket, Save, ShieldCheck, X } from "lucide-react";
import { agentsApi, AgentApiError, type AgentManifest, type HarnessView } from "../../../lib/client/agents";
import type { CompatibilityReportView } from "../../../lib/client/agents";
import {
  digestCompatibility,
  formFromManifest,
  idFromName,
  manifestFromForm,
  type AgentFormState,
} from "./agentForm";

const FIELD =
  "w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] outline-none placeholder:text-zinc-600 focus:border-cyan-400/50";
const LABEL = "text-[11px] font-medium uppercase tracking-wide text-zinc-500";
const SECTION = "rounded-lg border border-white/[0.07] bg-white/[0.02] p-3";

interface InstalledSkill {
  id: string;
  name: string;
  kind: string;
}

interface ProviderModelOption {
  id: string;
  models: string[];
}

function errorText(err: unknown): string {
  if (err instanceof AgentApiError) {
    const extra = err.details.missing?.length ? ` Missing: ${err.details.missing.join("; ")}` : "";
    const errors = err.details.errors?.length ? ` ${err.details.errors.join("; ")}` : "";
    return `${err.message}${errors}${extra}`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function AgentStudio({
  agentId,
  onSaved,
  onClose,
}: {
  agentId?: string;
  onSaved?: (manifest: AgentManifest) => void;
  onClose?: () => void;
}) {
  const [form, setForm] = useState<AgentFormState>(() => formFromManifest(null));
  const [harness, setHarness] = useState<HarnessView | null>(null);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [compat, setCompat] = useState<CompatibilityReportView | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const set = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const load = useCallback(async () => {
    try {
      const [harnesses, library, providers, connectorList] = await Promise.all([
        agentsApi.harnesses(),
        fetch("/api/library/items", { cache: "no-store" }).then((res) => (res.ok ? res.json() : { items: [] })),
        fetch("/api/providers", { cache: "no-store" }).then((res) => (res.ok ? res.json() : { catalog: [] })),
        fetch("/api/library/connectors", { cache: "no-store" }).then((res) => (res.ok ? res.json() : { connectors: [] })),
      ]);
      setHarness(harnesses.harnesses.find((entry) => entry.id === "swarm") ?? harnesses.harnesses[0] ?? null);
      const items = (library as { items?: InstalledSkill[] }).items ?? [];
      setSkills(items.filter((item) => item.kind === "skill"));
      const catalog = (providers as { catalog?: Array<{ models?: { default?: string; popular?: string[] } }> }).catalog ?? [];
      const models = new Set<string>();
      for (const entry of catalog) {
        if (entry.models?.default) models.add(entry.models.default);
        for (const model of entry.models?.popular ?? []) models.add(model);
      }
      setModelOptions([...models].sort());
      setConnectors(((connectorList as { connectors?: Array<{ id: string }> }).connectors ?? []).map((row) => row.id));
      if (agentId) {
        const loaded = await agentsApi.get(agentId);
        setForm(formFromManifest(loaded.agent));
      }
    } catch (err) {
      setError(errorText(err));
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const digest = useMemo(() => (compat ? digestCompatibility(compat) : null), [compat]);

  async function save(): Promise<AgentManifest | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const manifest = manifestFromForm(form);
      if (!manifest.id && manifest.name) {
        manifest.id = idFromName(manifest.name);
        set("id", manifest.id);
      }
      const saved = agentId ? await agentsApi.replace(agentId, manifest) : await agentsApi.create(manifest);
      setForm(formFromManifest(saved.agent));
      setNotice(agentId ? "Agent updated." : "Agent created.");
      onSaved?.(saved.agent);
      return saved.agent;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    const manifest = await save();
    if (!manifest) return;
    setBusy(true);
    try {
      const result = await agentsApi.compatibility(manifest.id);
      setCompat(result.report);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    const manifest = await save();
    if (!manifest) return;
    setBusy(true);
    setRunId(null);
    try {
      const result = await agentsApi.deploy(manifest.id, "swarm");
      setRunId(result.runId);
      setCompat(result.report);
      setNotice(`Deployed as run ${result.runId}.`);
    } catch (err) {
      if (err instanceof AgentApiError && err.details.missing?.length) {
        setCompat({ supported: [], missing: err.details.missing, warnings: err.details.warnings ?? [] });
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const supportedTools = harness?.capabilities.tools ?? [];
  const memoryPolicies = (harness?.capabilities.memoryPolicies ?? ["none", "session", "persistent"]) as Array<
    AgentFormState["memoryPolicy"]
  >;

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#08080c] text-zinc-200" data-testid="agent-studio">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <h2 className="text-[13px] font-semibold">{agentId ? "Edit agent" : "New agent"}</h2>
        <span className="flex-1" />
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" aria-hidden /> : null}
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50"
        >
          <ShieldCheck className="h-3 w-3" aria-hidden /> Check compatibility
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50"
        >
          <Save className="h-3 w-3" aria-hidden /> Save
        </button>
        <button
          type="button"
          onClick={() => void deploy()}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/15 disabled:opacity-50"
        >
          <Rocket className="h-3 w-3" aria-hidden /> Deploy
        </button>
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:text-zinc-200" aria-label="Close builder">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
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
        </div>
      ) : null}
      {digest ? (
        <div className="border-b border-white/[0.07] px-3 py-2" data-testid="agent-compat">
          <p className={`text-[11px] font-medium ${digest.ok ? "text-emerald-300" : "text-amber-300"}`}>{digest.headline}</p>
          {digest.missing.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {digest.missing.map((entry) => (
                <li key={entry} className="text-[11px] text-red-300/90">• {entry}</li>
              ))}
            </ul>
          ) : null}
          {digest.warnings.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {digest.warnings.map((entry) => (
                <li key={entry} className="text-[11px] text-amber-200/80">• {entry}</li>
              ))}
            </ul>
          ) : null}
          {runId ? <p className="mt-1 text-[11px] text-cyan-300">Run {runId} started.</p> : null}
        </div>
      ) : null}

      <div className="sa-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <section className={SECTION}>
          <h3 className={LABEL}>Identity</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-zinc-500">Name</span>
              <input className={FIELD} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Triage bot" />
            </label>
            <label className="block">
              <span className="text-[11px] text-zinc-500">Id</span>
              <input
                className={FIELD}
                value={form.id}
                onChange={(e) => set("id", idFromName(e.target.value))}
                placeholder="triage-bot"
                disabled={Boolean(agentId)}
              />
            </label>
          </div>
          <label className="mt-2 block">
            <span className="text-[11px] text-zinc-500">Description</span>
            <input className={FIELD} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          <label className="mt-2 block">
            <span className="text-[11px] text-zinc-500">System prompt</span>
            <textarea
              className={`${FIELD} h-28 resize-y font-mono`}
              value={form.systemPrompt}
              onChange={(e) => set("systemPrompt", e.target.value)}
              placeholder="You are…"
            />
          </label>
          <label className="mt-2 block">
            <span className="text-[11px] text-zinc-500">Tone (optional)</span>
            <input className={FIELD} value={form.tone} onChange={(e) => set("tone", e.target.value)} />
          </label>
        </section>

        <section className={SECTION}>
          <h3 className={LABEL}>Models</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-zinc-500">Preferred</span>
              <select className={FIELD} value={form.preferredModel} onChange={(e) => set("preferredModel", e.target.value)}>
                <option value="">Choose a model…</option>
                {modelOptions.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-zinc-500">Fallbacks (max 3)</span>
              <select
                className={`${FIELD} h-20`}
                multiple
                value={form.fallbackModels}
                onChange={(e) =>
                  set(
                    "fallbackModels",
                    [...e.target.selectedOptions].map((option) => option.value).slice(0, 3),
                  )
                }
              >
                {modelOptions.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className={SECTION}>
          <h3 className={LABEL}>Tools</h3>
          <p className="mt-1 text-[11px] text-zinc-500">Only tools this harness can grant are listed.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {supportedTools.map((tool) => (
              <button
                key={tool}
                type="button"
                onClick={() => set("tools", toggle(form.tools, tool))}
                className={`rounded-md border px-2 py-0.5 text-[11px] ${
                  form.tools.includes(tool)
                    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                    : "border-white/10 text-zinc-400 hover:bg-white/[0.06]"
                }`}
              >
                {tool}
              </button>
            ))}
          </div>
          <h3 className={`${LABEL} mt-3`}>Deny list</h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {supportedTools.map((tool) => (
              <button
                key={`deny-${tool}`}
                type="button"
                onClick={() => set("denyTools", toggle(form.denyTools, tool))}
                className={`rounded-md border px-2 py-0.5 text-[11px] ${
                  form.denyTools.includes(tool)
                    ? "border-red-400/40 bg-red-400/10 text-red-200"
                    : "border-white/10 text-zinc-400 hover:bg-white/[0.06]"
                }`}
              >
                {tool}
              </button>
            ))}
          </div>
        </section>

        <section className={SECTION}>
          <div className="flex items-center">
            <h3 className={LABEL}>MCP servers</h3>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => set("mcp", [...form.mcp, { name: "", transport: "stdio", command: "", url: "" }])}
              className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
            >
              Add server
            </button>
          </div>
          {form.mcp.length === 0 ? <p className="mt-1 text-[11px] text-zinc-600">None configured.</p> : null}
          {form.mcp.map((row, index) => (
            <div key={index} className="mt-2 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
              <input
                className={FIELD}
                placeholder="name"
                value={row.name}
                onChange={(e) => {
                  const next = [...form.mcp];
                  next[index] = { ...row, name: e.target.value };
                  set("mcp", next);
                }}
              />
              <select
                className={FIELD}
                value={row.transport}
                onChange={(e) => {
                  const next = [...form.mcp];
                  next[index] = { ...row, transport: e.target.value as typeof row.transport };
                  set("mcp", next);
                }}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
              <input
                className={FIELD}
                placeholder={row.transport === "stdio" ? "command" : "url"}
                value={row.transport === "stdio" ? row.command : row.url}
                onChange={(e) => {
                  const next = [...form.mcp];
                  next[index] = row.transport === "stdio" ? { ...row, command: e.target.value } : { ...row, url: e.target.value };
                  set("mcp", next);
                }}
              />
              <button
                type="button"
                onClick={() => set("mcp", form.mcp.filter((_, i) => i !== index))}
                className="rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:text-red-300"
                aria-label="Remove MCP server"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))}
        </section>

        <section className={SECTION}>
          <h3 className={LABEL}>Connectors</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {connectors.length === 0 ? <p className="text-[11px] text-zinc-600">No connectors in this environment.</p> : null}
            {connectors.map((connector) => (
              <button
                key={connector}
                type="button"
                onClick={() => set("connectors", toggle(form.connectors, connector))}
                className={`rounded-md border px-2 py-0.5 text-[11px] ${
                  form.connectors.includes(connector)
                    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                    : "border-white/10 text-zinc-400 hover:bg-white/[0.06]"
                }`}
              >
                {connector}
              </button>
            ))}
          </div>
        </section>

        <section className={SECTION}>
          <h3 className={LABEL}>Context &amp; skills</h3>
          <label className="mt-2 block">
            <span className="text-[11px] text-zinc-500">Context sources (comma separated ids or paths)</span>
            <input className={FIELD} value={form.context} onChange={(e) => set("context", e.target.value)} />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skills.length === 0 ? <p className="text-[11px] text-zinc-600">No installed skills.</p> : null}
            {skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => set("skills", toggle(form.skills, skill.id))}
                title={skill.id}
                className={`rounded-md border px-2 py-0.5 text-[11px] ${
                  form.skills.includes(skill.id)
                    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                    : "border-white/10 text-zinc-400 hover:bg-white/[0.06]"
                }`}
              >
                {skill.name}
              </button>
            ))}
          </div>
          <label className="mt-2 block">
            <span className="text-[11px] text-zinc-500">Workflows (comma separated ids)</span>
            <input className={FIELD} value={form.workflows} onChange={(e) => set("workflows", e.target.value)} />
          </label>
        </section>

        <section className={SECTION}>
          <h3 className={LABEL}>Memory</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-zinc-500">Policy</span>
              <select
                className={FIELD}
                value={form.memoryPolicy}
                onChange={(e) => set("memoryPolicy", e.target.value as AgentFormState["memoryPolicy"])}
              >
                {memoryPolicies.map((policy) => (
                  <option key={policy} value={policy}>{policy}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-zinc-500">Max entries (optional)</span>
              <input className={FIELD} value={form.maxEntries} onChange={(e) => set("maxEntries", e.target.value)} inputMode="numeric" />
            </label>
          </div>
        </section>

        <section className={SECTION}>
          <h3 className={LABEL}>Policies &amp; permissions</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-zinc-500">Max turns</span>
              <input className={FIELD} value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} inputMode="numeric" />
            </label>
            <label className="block">
              <span className="text-[11px] text-zinc-500">Max cost (USD)</span>
              <input className={FIELD} value={form.maxCostUsd} onChange={(e) => set("maxCostUsd", e.target.value)} inputMode="decimal" />
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              checked={form.approvalRequired}
              onChange={(e) => set("approvalRequired", e.target.checked)}
              className="h-3.5 w-3.5 accent-cyan-400"
            />
            Require approval before mutating tools
          </label>
        </section>

        <section className={SECTION}>
          <div className="flex items-center">
            <h3 className={LABEL}>Subagents</h3>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => set("subagents", [...form.subagents, { name: "", instructions: "", tools: "" }])}
              className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.06]"
            >
              Add subagent
            </button>
          </div>
          {form.subagents.length === 0 ? <p className="mt-1 text-[11px] text-zinc-600">None.</p> : null}
          {form.subagents.map((row, index) => (
            <div key={index} className="mt-2 space-y-1.5 rounded-md border border-white/[0.06] p-2">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
                <input
                  className={FIELD}
                  placeholder="name"
                  value={row.name}
                  onChange={(e) => {
                    const next = [...form.subagents];
                    next[index] = { ...row, name: e.target.value };
                    set("subagents", next);
                  }}
                />
                <input
                  className={FIELD}
                  placeholder="tools (comma separated)"
                  value={row.tools}
                  onChange={(e) => {
                    const next = [...form.subagents];
                    next[index] = { ...row, tools: e.target.value };
                    set("subagents", next);
                  }}
                />
                <button
                  type="button"
                  onClick={() => set("subagents", form.subagents.filter((_, i) => i !== index))}
                  className="rounded-md px-1.5 text-[11px] text-zinc-500 hover:text-red-300"
                  aria-label="Remove subagent"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
              <textarea
                className={`${FIELD} h-16 resize-y`}
                placeholder="instructions"
                value={row.instructions}
                onChange={(e) => {
                  const next = [...form.subagents];
                  next[index] = { ...row, instructions: e.target.value };
                  set("subagents", next);
                }}
              />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
