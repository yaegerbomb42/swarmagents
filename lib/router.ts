import type { LearnedLimits, ProviderConfig } from "./types";
import { getLimits, getProviders, saveLimits } from "./store";
import { ProviderError, type ChatRequest, type StreamCallbacks, type TurnResult } from "./providers/types";
import { streamAnthropic } from "./providers/anthropic";
import { streamOpenAI } from "./providers/openai";

// Organic rate-limit learning: no limits are configured up front. We record every request we send in a
// sliding one-minute window; when a provider throttles us, the load at that moment becomes its learned
// ceiling, and later requests are paced to stay just under it.

interface Sent {
  at: number;
  tokens: number;
}
const windows = new Map<string, Sent[]>();
const MINUTE = 60_000;

function windowFor(id: string) {
  const now = Date.now();
  const w = (windows.get(id) ?? []).filter((s) => now - s.at < MINUTE);
  windows.set(id, w);
  return w;
}

function updateLimits(id: string, fn: (l: LearnedLimits) => LearnedLimits) {
  const all = getLimits();
  all[id] = fn(all[id] ?? { throttles: 0 });
  saveLimits(all);
  return all[id];
}

/** Rough token estimate for pacing: ~4 chars per token over the serialized request. */
export function estimateTokens(v: unknown): number {
  let chars = 0;
  const walk = (x: unknown) => {
    if (typeof x === "string") chars += x.length;
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") for (const [k, val] of Object.entries(x)) k === "data" && typeof val === "string" ? (chars += 6000) : walk(val);
  };
  walk(v);
  return Math.ceil(chars / 4);
}

// Long runs must outlast outages and exhausted quotas, so a provider that keeps failing is benched for an
// escalating period rather than dropped. Consecutive failures reset on the first success. The deadline is
// persisted in LearnedLimits (benchUntil) because a restart must not immediately retry a provider we already
// know is out of credits - that is the whole point on a 24h run.
const bench = new Map<string, number>();
const streaks = new Map<string, number>();
const MAX_BENCH = 15 * MINUTE;

function benchFor(id: string, minMs = 0): number {
  const n = (streaks.get(id) ?? 0) + 1;
  streaks.set(id, n);
  const ms = Math.min(MAX_BENCH, Math.max(minMs, 5000 * 2 ** Math.min(n - 1, 8)));
  const until = Date.now() + ms;
  bench.set(id, until);
  updateLimits(id, (x) => ({ ...x, benchUntil: until }));
  return ms;
}

/** Bench deadline for a provider, honouring what a previous process persisted. */
function benchUntil(id: string): number {
  const mem = bench.get(id) ?? 0;
  const disk = getLimits()[id]?.benchUntil ?? 0;
  return Math.max(mem, disk);
}

/** Out of credits/quota: retrying soon is pointless, but the user may top up, so wait instead of giving up. */
function isExhausted(err: ProviderError) {
  // A short retry hint or a per-minute limit is ordinary throttling, even when the text links to a billing page.
  if ((err.retryAfterMs !== undefined && err.retryAfterMs < 5 * MINUTE) || /per minute|\b[rt]pm\b|try again in [\d.]+m?s/i.test(err.message)) return false;
  return /insufficient.?(quota|credits?|balance|funds)|credit balance is too low|payment required|out of credits|exceeded your current quota|quota exceeded for|daily (limit|quota)|per.?day/i.test(err.message);
}

/** How long we must wait before this provider can take a request of `tokens` without exceeding learned limits. */
function waitNeeded(p: ProviderConfig, tokens: number): number {
  const l = getLimits()[p.id];
  const now = Date.now();
  const benched = benchUntil(p.id);
  if (benched > now) return Math.max(benched - now, l?.cooldownUntil && l.cooldownUntil > now ? l.cooldownUntil - now : 0);
  if (l?.cooldownUntil && l.cooldownUntil > now) return l.cooldownUntil - now;
  if (!l) return 0;
  const w = windowFor(p.id);
  if (!w.length) return 0;
  // Stay at 90% of the observed ceiling.
  if (l.rpm && w.length >= Math.floor(l.rpm * 0.9)) return w[0].at + MINUTE - now;
  if (l.tpm) {
    const used = w.reduce((s, x) => s + x.tokens, 0);
    if (used + tokens > l.tpm * 0.9) {
      let freed = used + tokens - l.tpm * 0.9;
      for (const s of w) {
        freed -= s.tokens;
        if (freed <= 0) return s.at + MINUTE - now;
      }
      return MINUTE;
    }
  }
  return 0;
}

export function activeProviders() {
  return getProviders().filter((p) => p.enabled && p.model);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), rej(new ProviderError("aborted", "stopped"))), { once: true });
  });

/** A stream silent this long is presumed hung (dead connection, wedged proxy) and is retried. */
const STALL_MS = Number(process.env.SWARM_STALL_MS) || 5 * MINUTE;

/** Run one provider call under a watchdog that aborts it if no stream activity arrives for STALL_MS. */
async function watched(p: ProviderConfig, req: ChatRequest, cb: StreamCallbacks): Promise<TurnResult> {
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  req.signal.addEventListener("abort", onOuter, { once: true });
  let last = Date.now();
  let stalled = false;
  const beat =
    <A extends unknown[]>(f: (...a: A) => void) =>
    (...a: A) => {
      last = Date.now();
      f(...a);
    };
  const timer = setInterval(() => {
    if (Date.now() - last > STALL_MS) {
      stalled = true;
      ac.abort();
    }
  }, 5000);
  const wcb: StreamCallbacks = { onThinking: beat(cb.onThinking), onText: beat(cb.onText), onToolStart: beat(cb.onToolStart), onToolInput: beat(cb.onToolInput), onBlockEnd: beat(cb.onBlockEnd) };
  const wreq = { ...req, signal: ac.signal };
  try {
    return p.kind === "anthropic" ? await streamAnthropic(p, wreq, wcb) : await streamOpenAI(p, wreq, wcb);
  } catch (e) {
    if (stalled && !req.signal.aborted) throw new ProviderError("transient", `no response for ${Math.round(STALL_MS / 1000)}s (stream stalled)`);
    throw e;
  } finally {
    clearInterval(timer);
    req.signal.removeEventListener("abort", onOuter);
  }
}

export interface RouterHooks {
  onNotice(level: "info" | "warn", text: string): void;
  /** Called before each attempt so the UI can reset partially streamed output from a failed attempt. */
  onAttempt(p: ProviderConfig): void;
}

/**
 * Run one model turn. Providers are tried in the user's order. Rate limits are learned and routed
 * around; transient errors retry with backoff; context overflows are raised for the agent to compact.
 */
export async function routeTurn(req: ChatRequest, cb: StreamCallbacks, hooks: RouterHooks): Promise<TurnResult & { provider: ProviderConfig }> {
  const providers = activeProviders();
  if (!providers.length) throw new ProviderError("fatal", "No LLM provider configured. Open Settings and add an API key.");
  const tokens = estimateTokens(req.messages) + estimateTokens(req.system) + estimateTokens(req.tools);
  // Only bad keys and permanently rejected requests remove a provider; everything else is waited out.
  const dead = new Set<string>();
  let transientTries = 0;

  for (;;) {
    const live = providers.filter((p) => !dead.has(p.id));
    if (!live.length) throw new ProviderError("fatal", "Every configured provider failed. Check keys in Settings.");
    // Prefer the first provider that is ready now; otherwise wait for whichever frees up soonest.
    const ranked = live.map((p) => ({ p, wait: waitNeeded(p, tokens) }));
    const ready = ranked.find((r) => r.wait === 0);
    const pick = ready ?? ranked.reduce((a, b) => (b.wait < a.wait ? b : a));
    if (!ready) {
      const secs = Math.ceil(pick.wait / 1000);
      const when = secs >= 120 ? `${Math.round(secs / 60)}m` : `${secs}s`;
      hooks.onNotice(
        pick.wait >= MINUTE ? "warn" : "info",
        live.length > 1 ? `All providers are busy or out of quota. Waiting ${when} for ${pick.p.label}; the run continues automatically.` : `Waiting ${when} for ${pick.p.label} (rate limit or outage); the run continues automatically.`,
      );
      await sleep(pick.wait, req.signal);
    }
    const p = pick.p;
    const w = windowFor(p.id);
    w.push({ at: Date.now(), tokens });
    hooks.onAttempt(p);

    try {
      const r = await watched(p, req, cb);
      const l = getLimits()[p.id];
      if (l?.lastError || l?.benchUntil) updateLimits(p.id, (x) => ({ ...x, lastError: undefined, benchUntil: undefined }));
      streaks.delete(p.id);
      bench.delete(p.id);
      return { ...r, provider: p };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("transient", String(e));
      if (err.kind === "aborted" || err.kind === "context") throw err;
      if (isExhausted(err)) {
        const ms = benchFor(p.id, 5 * MINUTE);
        updateLimits(p.id, (x) => ({ ...x, lastError: err.message.slice(0, 300) }));
        hooks.onNotice("warn", `${p.label} is out of credits or quota. ${live.length > 1 ? "Failing over" : `Retrying in ${Math.round(ms / MINUTE)}m`}; top up or add another provider in Settings.`);
        continue;
      }
      if (err.kind === "rate_limit") {
        const cur = windowFor(p.id);
        const load = cur.reduce((s, x) => s + x.tokens, 0);
        // Repeated throttles with no success in between mean a long-window quota, so back off further each time.
        const cooldown = err.retryAfterMs ?? benchFor(p.id);
        const l = updateLimits(p.id, (x) => ({
          ...x,
          throttles: x.throttles + 1,
          lastThrottleAt: Date.now(),
          cooldownUntil: Date.now() + cooldown,
          // Only tighten on a real signal; one-request windows say nothing about RPM.
          rpm: cur.length > 1 ? Math.min(x.rpm ?? Infinity, cur.length - 1) : x.rpm,
          tpm: load > tokens ? Math.min(x.tpm ?? Infinity, load - tokens) : tokens < (x.tpm ?? Infinity) && cur.length === 1 ? tokens : x.tpm,
          lastError: err.message.slice(0, 300),
        }));
        hooks.onNotice(
          "warn",
          `${p.label} rate-limited us (${cur.length} req, ~${Math.round(load / 1000)}k tok in the last minute). Learned ceiling: ${l.rpm ?? "?"} rpm / ${l.tpm ? Math.round(l.tpm / 1000) + "k" : "?"} tpm. ${live.length > 1 ? "Failing over." : `Retrying in ${Math.ceil(cooldown / 1000)}s.`}`,
        );
        continue;
      }
      if (err.kind === "auth" || err.kind === "fatal") {
        updateLimits(p.id, (x) => ({ ...x, lastError: err.message.slice(0, 300) }));
        dead.add(p.id);
        hooks.onNotice("warn", `${p.label} failed: ${err.message.slice(0, 200)}${dead.size < providers.length ? " Trying next provider." : ""}`);
        if (dead.size >= providers.length) throw err;
        continue;
      }
      // transient
      transientTries++;
      if (transientTries > 4) {
        transientTries = 0;
        const ms = benchFor(p.id, 30_000);
        hooks.onNotice("warn", `${p.label} keeps failing (${err.message.slice(0, 120)}). ${live.length > 1 ? "Moving on" : `Pausing ${Math.ceil(ms / 1000)}s before retrying`}.`);
        continue;
      }
      const delay = err.retryAfterMs ?? 1000 * 2 ** transientTries;
      hooks.onNotice("info", `${p.label}: ${err.message.slice(0, 120)}. Retrying in ${Math.ceil(delay / 1000)}s.`);
      await sleep(delay, req.signal);
    }
  }
}

/** Best-known context window for the provider's model. */
export function contextWindow(p: ProviderConfig | undefined): number {
  if (!p) return 200_000;
  const learned = getLimits()[p.id]?.contextWindow;
  if (learned) return learned;
  const m = p.model.toLowerCase();
  if (/claude-(opus|sonnet|fable|mythos)-5|claude-(opus|sonnet)-4-[678]/.test(m)) return 1_000_000;
  if (/claude/.test(m)) return 200_000;
  if (/gpt-5|gpt-4\.1/.test(m)) return 400_000;
  if (/gemini/.test(m)) return 1_000_000;
  if (/grok-4/.test(m)) return 256_000;
  if (/deepseek/.test(m)) return 128_000;
  return 128_000;
}

export function setLearnedContext(id: string, tokens: number) {
  updateLimits(id, (x) => ({ ...x, contextWindow: tokens }));
}
