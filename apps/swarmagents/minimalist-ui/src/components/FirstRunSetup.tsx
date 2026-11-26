"use client";

/**
 * FirstRunSetup — the first-run wizard of a brand-new account with no model
 * provider. Three steps, in order:
 *
 *   1. Pick a provider (free-tier options first, with a link to get a key).
 *   2. Paste the key and press Test: the core-20 key probe
 *      (POST /api/providers/[id]/test) answers with ok, latency and the run
 *      mode badge (Desktop / Text desktop / Chat).
 *   3. "Try it": three canned sample tasks sized for 1–3 minutes. Clicking
 *      one dispatches it through the normal /api/runtime/tasks path, closes
 *      the setup, and lands on the live run.
 *
 * The decision of when the wizard shows lives in `firstRunSetup`
 * (hooks/useEnvironment.ts), which is unit-tested. Completion is persisted
 * by the app: once a run finishes, the account's `firstRunCompleted` setting
 * is set and the wizard never reappears; Settings keeps a "Run a sample
 * task" entry to replay step 3.
 */

import React, { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, Play, Zap } from "lucide-react";
import type { SampleTask } from "../lib/sampleTasks";
import { SAMPLE_TASKS } from "../lib/sampleTasks";
import { Button } from "./ui";

export type FrStep = "provider" | "key" | "try";

/** A provider a brand-new account can onboard with, in a curated order. */
export interface OnboardProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiStyle: string;
  authScheme: string;
  keyHint: string;
  /** Where to get a key, or a docs link for keyless local providers. */
  getKeyUrl?: string;
  /** Runs on the user's own machine; no key is sent. */
  local: boolean;
  /** Free tier available (listed before paid providers). */
  free: boolean;
}

/**
 * The preset list for step 1. Free-tier options come first (hosted free
 * tiers, then a self-hosted Ollama), paid providers after. The list is deliberately
 * short: onboarding should not be a catalog survey.
 */
export const ONBOARD_PROVIDERS: readonly OnboardProviderPreset[] = [
  {
    id: "ollama",
    name: "Ollama (self-hosted)",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.1",
    apiStyle: "ollama",
    authScheme: "none",
    keyHint: "No key needed. Your Ollama server must be reachable from SwarmAgents.",
    getKeyUrl: "https://ollama.com",
    local: true,
    free: true,
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    apiStyle: "openai-chat",
    authScheme: "bearer",
    keyHint: "gsk_…",
    getKeyUrl: "https://console.groq.com/keys",
    local: false,
    free: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    apiStyle: "gemini",
    authScheme: "x-goog-api-key",
    keyHint: "AIza…",
    getKeyUrl: "https://aistudio.google.com/app/apikey",
    local: false,
    free: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    apiStyle: "openai-chat",
    authScheme: "bearer",
    keyHint: "…",
    getKeyUrl: "https://console.mistral.ai/api-keys/",
    local: false,
    free: true,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    apiStyle: "openai-chat",
    authScheme: "bearer",
    keyHint: "…",
    getKeyUrl: "https://cloud.cerebras.ai/api-keys",
    local: false,
    free: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    apiStyle: "anthropic",
    authScheme: "x-api-key",
    keyHint: "sk-ant-…",
    getKeyUrl: "https://console.anthropic.com/settings/keys",
    local: false,
    free: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiStyle: "openai-chat",
    authScheme: "bearer",
    keyHint: "sk-…",
    getKeyUrl: "https://platform.openai.com/api-keys",
    local: false,
    free: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiStyle: "openai-chat",
    authScheme: "bearer",
    keyHint: "sk-…",
    getKeyUrl: "https://platform.deepseek.com/api_keys",
    local: false,
    free: false,
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4",
    apiStyle: "openai-chat",
    authScheme: "bearer",
    keyHint: "xai-…",
    getKeyUrl: "https://console.x.ai",
    local: false,
    free: false,
  },
];

/** Free-tier presets first, then the rest (stable within each group). */
export function orderedOnboardProviders(): readonly OnboardProviderPreset[] {
  return [
    // Hosted free tiers first: they work from any deployment. A self-hosted
    // Ollama only works when the SwarmAgents server can reach it, so it is
    // the last free option, not the default.
    ...ONBOARD_PROVIDERS.filter((p) => p.free && !p.local),
    ...ONBOARD_PROVIDERS.filter((p) => p.free && p.local),
    ...ONBOARD_PROVIDERS.filter((p) => !p.free),
  ];
}

/** The POST /api/providers body for a preset + pasted key. */
export function buildProviderSaveBody(
  preset: OnboardProviderPreset,
  apiKey: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: preset.id,
    apiStyle: preset.apiStyle,
    auth: { scheme: preset.authScheme },
    baseUrl: preset.baseUrl,
    models: [preset.model],
  };
  if (!preset.local) body.apiKey = apiKey.trim();
  return body;
}

/** Badge text for a run-mode id returned by the key probe. */
export function modeBadge(mode: string | undefined): string {
  switch (mode) {
    case "gui":
      return "Desktop";
    case "text-desktop":
      return "Text desktop";
    case "chat":
      return "Chat";
    default:
      return "Text";
  }
}

export type ProbeOutcome =
  | { ok: true; latencyMs: number; mode: string | undefined; label: string; model?: string }
  | { ok: false; error: string };

/**
 * Save the provider (POST /api/providers) then run the core-20 key probe
 * (POST /api/providers/[id]/test). Reuses the per-provider probe endpoint;
 * no second probe is built.
 */
export async function testProviderConnection(
  preset: OnboardProviderPreset,
  apiKey: string,
): Promise<ProbeOutcome> {
  try {
    const saveRes = await fetch("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildProviderSaveBody(preset, apiKey)),
    });
    if (!saveRes.ok) {
      const body = (await saveRes.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? "Could not save the provider." };
    }
    const res = await fetch(`/api/providers/${encodeURIComponent(preset.id)}/test`, {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as {
      test?: { ok?: boolean; latencyMs?: number | null; error?: string; model?: string };
      runMode?: { mode?: string; label?: string };
      error?: string;
    };
    if (!res.ok || !data.test?.ok) {
      return { ok: false, error: data.test?.error ?? data.error ?? "Connection test failed." };
    }
    return {
      ok: true,
      latencyMs: data.test.latencyMs ?? 0,
      mode: data.runMode?.mode,
      label: data.runMode?.label ?? "",
      model: data.test.model,
    };
  } catch {
    return { ok: false, error: "Could not reach the server. Try again." };
  }
}

const STEP_LABELS: { id: FrStep; title: string }[] = [
  { id: "provider", title: "Pick a provider" },
  { id: "key", title: "Connect your key" },
  { id: "try", title: "Run a sample" },
];

export interface FirstRunSetupProps {
  /** Dispatch a sample task through the normal run path. */
  onRunSample: (sample: SampleTask) => Promise<{ ok: boolean; error?: string }>;
  /** The user chose to set up later; hide the wizard for this visit. */
  onLater?: () => void;
  /** Step to start on. Defaults to "provider"; used by tests. */
  initialStep?: FrStep;
  /** Preset preselected when `initialStep` is "key". Used by tests. */
  initialPreset?: OnboardProviderPreset;
}

export function FirstRunSetup({
  onRunSample,
  onLater,
  initialStep = "provider",
  initialPreset,
}: FirstRunSetupProps) {
  const [step, setStep] = useState<FrStep>(initialStep);
  const [preset, setPreset] = useState<OnboardProviderPreset | null>(initialPreset ?? null);

  const selectPreset = useCallback((p: OnboardProviderPreset) => {
    setPreset(p);
    setStep("key");
  }, []);

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pb-6" data-testid="first-run-setup">
      <div className="enter flex justify-center mb-6">
        <div className="orb" data-state="idle" style={{ width: 68, height: 68 }}>
          <div className="orb-glow" />
          <div className="orb-core" />
        </div>
      </div>
      <h1 className="text-center text-[26px] font-semibold leading-tight tracking-tight text-[var(--fg)]">
        Set up your first run
      </h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-[var(--mute)] leading-relaxed">
        One provider key, a quick check, and a sample task you can watch
        finish. About two minutes, nothing to read.
      </p>

      <ol
        data-testid="first-run-steps"
        className="mx-auto mt-6 flex max-w-xl items-center justify-center gap-2"
      >
        {STEP_LABELS.map((s, i) => (
          <li
            key={s.id}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium ${
              step === s.id ? "bg-white/10 text-[var(--fg)] ring-1 ring-white/15" : "text-[var(--mute)]"
            }`}
          >
            <span className="font-mono">{String(i + 1)}</span> {s.title}
          </li>
        ))}
      </ol>

      {step === "provider" && (
        <ProviderStep onSelect={selectPreset} onLater={onLater} />
      )}
      {step === "key" && preset && (
        <KeyStep preset={preset} onBack={() => setStep("provider")} onConnected={() => setStep("try")} />
      )}
      {step === "try" && (
        <TryStep onRunSample={onRunSample} />
      )}
    </div>
  );
}

/* ---------------- Step 1: pick a provider ---------------- */

function ProviderStep({
  onSelect,
  onLater,
}: {
  onSelect: (p: OnboardProviderPreset) => void;
  onLater?: () => void;
}) {
  const providers = orderedOnboardProviders();
  return (
    <div className="mt-6" data-testid="fr-step-provider">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--fg)]">Choose a provider</h2>
        <span className="text-[11px] text-[var(--mute)]">Free tiers listed first</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            data-testid={`fr-provider-${p.id}`}
            onClick={() => onSelect(p)}
            className="group flex w-full items-start gap-3 rounded-2xl bg-black/20 p-3 text-left ring-1 ring-white/10 transition hover:bg-white/[0.06] hover:ring-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
          >
            <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-cyan-400/70" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-[var(--fg)]">{p.name}</span>
                {p.free && (
                  <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-emerald-300/90 ring-1 ring-emerald-400/20">
                    Free
                  </span>
                )}
                {p.local && (
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/50 ring-1 ring-white/10">
                    Local
                  </span>
                )}
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-[var(--mute)]">
                {p.local ? "Runs on this machine — no key." : "Bring your own key."}
              </span>
            </span>
          </button>
        ))}
      </div>
      {onLater && (
        <button
          type="button"
          data-testid="fr-later"
          onClick={onLater}
          className="mt-4 text-[11px] text-[var(--mute)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
        >
          I’ll add a provider later
        </button>
      )}
    </div>
  );
}

/* ---------------- Step 2: paste key + test ---------------- */

function KeyStep({
  preset,
  onBack,
  onConnected,
}: {
  preset: OnboardProviderPreset;
  onBack: () => void;
  onConnected: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ProbeOutcome | null>(null);

  const test = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    const result = await testProviderConnection(preset, key);
    setOutcome(result);
    setBusy(false);
  }, [busy, key, preset]);

  return (
    <div className="mt-6" data-testid="fr-step-key">
      <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/10">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan-400/70" />
          <span className="text-sm font-medium text-[var(--fg)]">{preset.name}</span>
          {preset.free && (
            <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-emerald-300/90 ring-1 ring-emerald-400/20">
              Free tier
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[var(--mute)]">
          Stored per-account on the server, encrypted at rest. Only used for your runs.
        </p>

        {!preset.local ? (
          <label className="mt-3 block">
            <span className="mb-1 block text-[10px] uppercase tracking-widest text-[var(--mute)]">
              API key
            </span>
            <div className="flex items-center rounded-xl bg-black/30 ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-cyan-400/60">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={preset.keyHint}
                data-testid="fr-key-input"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-xs text-[var(--fg)] placeholder:text-white/25 focus:outline-none"
              />
            </div>
            {preset.getKeyUrl && (
              <a
                href={preset.getKeyUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="fr-get-key"
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-cyan-300/90 hover:text-cyan-200"
              >
                Get a key at {preset.getKeyUrl.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </label>
        ) : (
          <p className="mt-3 rounded-xl bg-black/30 px-3 py-2 text-[11px] text-[var(--mute)] ring-1 ring-white/10">
            {preset.keyHint} The test checks that the local endpoint is reachable.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" size="sm" data-testid="fr-test" onClick={() => void test()} loading={busy}>
            <Zap className="h-3.5 w-3.5" />
            Test connection
          </Button>
          <Button size="sm" variant="ghost" data-testid="fr-back" onClick={onBack} disabled={busy}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        </div>

        {outcome && !busy && (
          outcome.ok ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-emerald-400/10 px-3 py-2 ring-1 ring-emerald-400/20" data-testid="fr-test-ok">
              <span className="flex items-center gap-1 text-xs text-emerald-300/90">
                <Check className="h-3.5 w-3.5" />
                Connected
              </span>
              <span className="font-mono text-[11px] text-emerald-300/80">
                {outcome.latencyMs} ms
              </span>
              {outcome.mode && (
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/80 ring-1 ring-white/15" data-testid="fr-mode-badge">
                  {modeBadge(outcome.mode)}
                </span>
              )}
              <Button size="sm" variant="primary" data-testid="fr-continue" className="ml-auto" onClick={onConnected}>
                Continue <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-[11px] text-red-300/90 ring-1 ring-red-400/20" data-testid="fr-test-err">
              {outcome.error} You can test again — nothing is saved until the test passes.
            </div>
          )
        )}
      </div>
    </div>
  );
}

/* ---------------- Step 3: try a sample task ---------------- */

/**
 * The sample-task list, shared by the first-run wizard and the Settings
 * "Run a sample task" replay entry. Each card dispatches its sample through
 * the caller's `onRunSample`; busy and error state live here.
 */
export function SampleTaskPicker({
  onRunSample,
  testIdPrefix = "fr-sample",
}: {
  onRunSample: (sample: SampleTask) => Promise<{ ok: boolean; error?: string }>;
  /** Prefix for the card test ids (`<prefix>-<sample-id>`). */
  testIdPrefix?: string;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (sample: SampleTask) => {
      if (busyId) return;
      setBusyId(sample.id);
      setError(null);
      const result = await onRunSample(sample);
      setBusyId(null);
      if (!result.ok) setError(result.error ?? "The run could not be started.");
    },
    [busyId, onRunSample],
  );

  return (
    <div>
      <div className="grid gap-2">
        {SAMPLE_TASKS.map((sample) => (
          <div
            key={sample.id}
            className="flex items-start gap-3 rounded-2xl bg-black/20 p-3.5 ring-1 ring-white/10"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-[var(--fg)]">{sample.title}</span>
                <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] text-white/45 ring-1 ring-white/10">
                  {sample.minutes}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--mute)]">{sample.blurb}</p>
              <p className="mt-1 text-[11px] text-cyan-300/80">
                Deliverable: <span className="font-mono">{sample.deliverable}</span>
              </p>
            </div>
            <Button
              size="sm"
              variant="primary"
              data-testid={`${testIdPrefix}-${sample.id}`}
              loading={busyId === sample.id}
              onClick={() => void run(sample)}
            >
              <Play className="h-3.5 w-3.5" />
              Run
            </Button>
          </div>
        ))}
      </div>
      {error && (
        <div className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-[11px] text-red-300/90 ring-1 ring-red-400/20" data-testid={`${testIdPrefix}-error`}>
          {error}
        </div>
      )}
    </div>
  );
}

export function TryStep({
  onRunSample,
}: {
  onRunSample: (sample: SampleTask) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <div className="mt-6" data-testid="fr-step-try">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-[var(--fg)]">Try it — your first run</h2>
        <p className="mt-0.5 text-[11px] text-[var(--mute)]">
          Each sample takes 1–3 minutes and leaves a deliverable file in your workspace.
        </p>
      </div>
      <SampleTaskPicker onRunSample={onRunSample} />
    </div>
  );
}

export default FirstRunSetup;
