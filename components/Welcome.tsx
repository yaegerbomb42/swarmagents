"use client";

// First run: a new account with no model connected gets this card instead of an empty Settings sheet.
// Step 1 connects a model in about 30 seconds: pick a provider, open its key page, paste, and it's tested live.
// Step 2 suggests a first task that works with no other setup (shell + files in the account's sandbox).
import { useEffect, useRef, useState } from "react";
import { PRESETS, type Preset } from "@/lib/presets";
import { detectProviderFromKey } from "@/lib/connections/key-detect";
import "./welcome.css";

/** The providers offered up front: the ones most people already have a key for. Everything else is in Settings. */
export const WELCOME_PROVIDERS = ["openrouter", "anthropic", "openai", "gemini", "groq", "xai", "deepseek", "mistral"] as const;

export const FIRST_TASKS = [
  {
    title: "Write and run a script",
    text: "Write a small Python script that prints the first 20 prime numbers, save it as primes.py, run it, and show me the output.",
  },
  {
    title: "Make a mini website",
    text: "Create a one-page website in index.html with a heading, a short paragraph about what you can do, and a button that changes the background color. Then show me a preview.",
  },
  {
    title: "Research a question",
    text: "Search the web for the three most popular open-source note-taking apps right now and give me a short comparison table.",
  },
];

type TestState = { state: "idle" } | { state: "testing" } | { state: "ok"; message: string } | { state: "err"; message: string };

const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export function Welcome({ connected, onConnected, onOpenSettings, onRunTask }: { connected: boolean; onConnected: () => void; onOpenSettings: () => void; onRunTask: (text: string) => Promise<void> }) {
  const choices = WELCOME_PROVIDERS.map(presetById).filter((p): p is Preset => !!p);
  const [pick, setPick] = useState<string>(choices[0]?.id ?? "openrouter");
  const [key, setKey] = useState("");
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const [switched, setSwitched] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [running, setRunning] = useState<number | null>(null);
  const [taskError, setTaskError] = useState("");
  const seq = useRef(0);
  const preset = presetById(pick);

  // Live test: shortly after a key is pasted or typed, ask the provider whether it works. Stale answers are dropped.
  useEffect(() => {
    const k = key.trim();
    setSaveError("");
    if (k.length < 12) return setTest({ state: "idle" });
    const id = ++seq.current;
    setTest({ state: "testing" });
    const t = setTimeout(async () => {
      const r = await fetch("/api/connections/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "llm", preset: pick, apiKey: k }) }).catch(() => null);
      const body = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; message?: string }) : {};
      if (id !== seq.current) return;
      if (!r) return setTest({ state: "err", message: "Couldn't reach the SwarmAgents server." });
      setTest(body.ok ? { state: "ok", message: body.message ?? "Connected" } : { state: "err", message: body.message ?? `Test failed (${r.status}).` });
    }, 450);
    return () => clearTimeout(t);
  }, [key, pick]);

  function onKeyChange(v: string) {
    setKey(v);
    // A recognizable key picks its own provider, so pasting an Anthropic key with OpenAI selected still just works.
    const d = detectProviderFromKey(v);
    if (d && d.preset !== pick && presetById(d.preset)) {
      setPick(d.preset);
      setSwitched(d.label);
    } else if (!v) setSwitched(null);
  }

  async function save() {
    if (test.state !== "ok" || saving) return;
    setSaving(true);
    setSaveError("");
    const r = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "llm", preset: pick, apiKey: key.trim() }) }).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setKey("");
      return onConnected();
    }
    const body = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : {};
    setSaveError(body.error ?? (r ? `Couldn't save the key (${r.status}).` : "Couldn't reach the SwarmAgents server."));
  }

  if (connected) {
    return (
      <section className="welcome" aria-labelledby="welcome-title">
        <p className="welcome-step">Step 2 of 2</p>
        <h1 id="welcome-title">You're connected. Try a first task</h1>
        <p className="welcome-lead">Pick one and watch every step happen live: the plan, the commands, the files it writes.</p>
        <div className="welcome-tasks">
          {FIRST_TASKS.map((t, i) => (
            <button
              key={t.title}
              type="button"
              className={`welcome-task${i === 0 ? " suggested" : ""}`}
              disabled={running !== null}
              onClick={() => {
                setRunning(i);
                setTaskError("");
                onRunTask(t.text).catch((e: Error) => {
                  setRunning(null);
                  setTaskError(e.message || "Couldn't start the task.");
                });
              }}
            >
              <span className="welcome-task-title">
                {t.title}
                {i === 0 && <span className="welcome-badge">Suggested</span>}
              </span>
              <span className="welcome-task-text">{t.text}</span>
              <span className="welcome-task-go">{running === i ? "Starting…" : "Run this task →"}</span>
            </button>
          ))}
        </div>
        {taskError && (
          <p className="welcome-test err" role="alert">
            {taskError}
          </p>
        )}
        <p className="welcome-foot">Or type your own task below.</p>
      </section>
    );
  }

  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <p className="welcome-step">Step 1 of 2 · about 30 seconds</p>
      <h1 id="welcome-title">Connect a model to get started</h1>
      <p className="welcome-lead">SwarmAgents runs on your own AI provider key. It's stored for your account only and never shown again.</p>

      <div className="welcome-providers" role="radiogroup" aria-label="Provider">
        {choices.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={pick === p.id}
            className={`welcome-provider${pick === p.id ? " active" : ""}`}
            onClick={() => {
              setPick(p.id);
              setSwitched(null);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <ol className="welcome-steps">
        <li>
          {preset?.keyUrl ? (
            <a className="welcome-keylink" href={preset.keyUrl} target="_blank" rel="noopener noreferrer">
              Get your {preset.label} API key ↗
            </a>
          ) : (
            <span>Create a key in your {preset?.label} account.</span>
          )}
          <span className="welcome-sub">Opens in a new tab. Create a key, copy it, and come back.</span>
        </li>
        <li>
          <label htmlFor="welcome-key" className="welcome-label">
            Paste it here
          </label>
          <input
            id="welcome-key"
            className="welcome-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${preset?.label ?? "Provider"} API key`}
            value={key}
            onChange={(e) => onKeyChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          {switched && <span className="welcome-sub">The key format matches {switched}, so it’s selected.</span>}
          <p className={`welcome-test ${test.state}`} role="status" aria-live="polite">
            {test.state === "idle" && "We'll test it as soon as you paste."}
            {test.state === "testing" && "Testing the key…"}
            {test.state === "ok" && `✓ ${test.message}`}
            {test.state === "err" && test.message}
          </p>
        </li>
      </ol>

      {saveError && (
        <p className="welcome-test err" role="alert">
          {saveError}
        </p>
      )}
      <div className="welcome-actions">
        <button type="button" className="btn primary" disabled={test.state !== "ok" || saving} onClick={save}>
          {saving ? "Saving…" : "Save and continue"}
        </button>
        <button type="button" className="welcome-more" onClick={onOpenSettings}>
          More providers, local models and settings ›
        </button>
      </div>
    </section>
  );
}
