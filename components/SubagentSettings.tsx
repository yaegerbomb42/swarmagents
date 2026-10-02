"use client";
import { useEffect, useRef, useState } from "react";
import type { SubagentMode, SubagentSettings as S } from "@/lib/subagent-settings";
import { AgentIcon } from "./agent-icons";

// Settings → Sub-agents (SA3). Saves each change straight away; the server validates and clamps.

interface Prov {
  id: string;
  label: string;
  model: string;
  enabled: boolean;
  models: string[];
}

const MODES: { id: SubagentMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "The agent does all the work itself, one step at a time." },
  { id: "auto", label: "Auto", hint: "The agent splits work across sub-agents when it helps, up to your limit, and runs fewer when your quota or rate limits are tight." },
  { id: "fixed", label: "Fixed", hint: "Always allow exactly this many at once. Extra work waits its turn if a provider pushes back." },
];

const BUDGETS: { v: number | null; label: string }[] = [
  { v: null, label: "No cap" },
  { v: 250_000, label: "250K tokens" },
  { v: 1_000_000, label: "1M tokens" },
  { v: 5_000_000, label: "5M tokens" },
  { v: 20_000_000, label: "20M tokens" },
];

const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export function SubagentSettings() {
  const [s, setS] = useState<S | null>(null);
  const [provs, setProvs] = useState<Prov[]>([]);
  const [lim, setLim] = useState({ parallelMin: 2, parallelMax: 10 });
  const [state, setState] = useState<"" | "saving" | "saved" | string>("");
  const [customBudget, setCustomBudget] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Changes made while a save is pending are merged, so a quick mode switch + slider drag sends both.
  const pending = useRef<Partial<S>>({});

  useEffect(() => {
    fetch("/api/settings/subagents")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        setS(d.settings);
        setProvs(d.providers ?? []);
        if (d.limits) setLim(d.limits);
      })
      .catch((e) => setState(`Couldn't load: ${e.message}`));
  }, []);

  const save = (patch: Partial<S>, delay = 0) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = pending.current;
      pending.current = {};
      setState("saving");
      try {
        const r = await fetch("/api/settings/subagents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setS(d.settings);
        setState("saved");
        setTimeout(() => setState((x) => (x === "saved" ? "" : x)), 1500);
      } catch (e) {
        setState((e as Error).message);
      }
    }, delay);
  };

  if (!s)
    return (
      <section className="st-section sa">
        <div className="st-section-head">
          <h3 className="agent-icon-h"><AgentIcon name="swarm" />Sub-agents</h3>
        </div>
        <div className="st-empty">{state || "Loading…"}</div>
      </section>
    );

  const mode = MODES.find((m) => m.id === s.mode)!;
  const prov = provs.find((p) => p.id === s.childProvider);
  const enabled = provs.filter((p) => p.enabled);
  const isPreset = BUDGETS.some((b) => b.v === s.budgetTokens);
  const err = state && state !== "saving" && state !== "saved" ? state : "";

  return (
    <section className="st-section sa">
      <div className="st-section-head">
        <h3 className="agent-icon-h"><AgentIcon name="swarm" />Sub-agents</h3>
        <span className={`sa-state${err ? " err" : ""}`} role="status">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}
        </span>
      </div>
      <p className="st-hint">Let the agent hand independent pieces of a task to helpers that work in parallel, each with its own fresh context.</p>

      <div className="sa-row">
        <span className="sa-label">Mode</span>
        <div className="sa-seg" role="radiogroup" aria-label="Sub-agent mode">
          {MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={s.mode === m.id} className={s.mode === m.id ? "on" : ""} onClick={() => s.mode !== m.id && save({ mode: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <p className="sa-note">{mode.hint}</p>

      {s.mode !== "off" && (
        <>
          <div className="sa-row">
            <label className="sa-label" htmlFor="sa-par">
              {s.mode === "auto" ? "At most" : "At once"}
            </label>
            <div className="sa-range">
              <input
                id="sa-par"
                type="range"
                min={lim.parallelMin}
                max={lim.parallelMax}
                step={1}
                value={s.maxParallel}
                onChange={(e) => save({ maxParallel: Number(e.target.value) }, 350)}
              />
              <span className="sa-num">{s.maxParallel}</span>
            </div>
          </div>

          <div className="sa-row">
            <label className="sa-label" htmlFor="sa-prov">
              Sub-agents use
            </label>
            <select id="sa-prov" className="input sa-select" value={prov ? s.childProvider : "same"} onChange={(e) => save({ childProvider: e.target.value, childModel: "" })}>
              <option value="same">Same as the main agent</option>
              {enabled.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.model ? ` · ${p.model}` : ""}
                </option>
              ))}
            </select>
          </div>
          {s.childProvider !== "same" && !prov && <p className="sa-note err">The connection chosen for sub-agents was removed. They follow the main agent until you pick another.</p>}
          {prov && (
            <div className="sa-row">
              <label className="sa-label" htmlFor="sa-model">
                Model
              </label>
              <input
                id="sa-model"
                className="input sa-select"
                list="sa-models"
                placeholder={prov.model || "Connection default"}
                value={s.childModel}
                onChange={(e) => save({ childModel: e.target.value }, 600)}
              />
              <datalist id="sa-models">
                {prov.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          )}
          {prov && <p className="sa-note">A smaller, cheaper model here stretches your quota; the main agent keeps its own model.</p>}

          <div className="sa-row">
            <label className="sa-label" htmlFor="sa-budget">
              Budget per split
            </label>
            <div className="sa-inline">
              <select
                id="sa-budget"
                className="input sa-select"
                value={isPreset ? String(s.budgetTokens) : "custom"}
                onChange={(e) => {
                  if (e.target.value === "custom") {
                    setCustomBudget(s.budgetTokens ? String(s.budgetTokens) : "2000000");
                    save({ budgetTokens: s.budgetTokens ?? 2_000_000 });
                  } else save({ budgetTokens: e.target.value === "null" ? null : Number(e.target.value) });
                }}
              >
                {BUDGETS.map((b) => (
                  <option key={String(b.v)} value={String(b.v)}>
                    {b.label}
                  </option>
                ))}
                <option value="custom">{isPreset ? "Custom…" : `Custom: ${fmtTokens(s.budgetTokens ?? 0)} tokens`}</option>
              </select>
              {!isPreset && (
                <input
                  className="input sa-small"
                  inputMode="numeric"
                  aria-label="Custom token budget"
                  value={customBudget || String(s.budgetTokens ?? "")}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d]/g, "");
                    setCustomBudget(v);
                    if (Number(v) >= 1000) save({ budgetTokens: Number(v) }, 600);
                  }}
                />
              )}
            </div>
          </div>
          <p className="sa-note">Total tokens all sub-agents of one split may use. When it runs out they stop and report what they have.</p>

          <div className="sa-row">
            <label className="sa-label" htmlFor="sa-steps">
              Steps each
            </label>
            <input
              id="sa-steps"
              className="input sa-small"
              type="number"
              min={5}
              max={1000}
              value={s.maxStepsPerChild}
              onChange={(e) => {
                const n = Number(e.target.value);
                setS({ ...s, maxStepsPerChild: n });
                if (Number.isInteger(n) && n >= 5 && n <= 1000) save({ maxStepsPerChild: n }, 600);
              }}
            />
          </div>
        </>
      )}
      {err && <p className="sa-note err">{err}</p>}
    </section>
  );
}
