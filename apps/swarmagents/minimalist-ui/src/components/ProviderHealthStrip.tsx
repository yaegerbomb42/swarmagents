"use client";

/**
 * ProviderHealthStrip — a compact row of status dots in the header showing
 * at a glance whether each of the user's BYOK providers is healthy, slow,
 * down, or unconfigured, before they start a run.
 *
 * Read-only surface over the existing health API (GET /api/providers/health,
 * lib/providers/health.ts + app/api/providers/health/route.ts): it never
 * touches the health backend. It polls on mount and every 60s; a poll
 * failure degrades to grey dots and never crashes the header or logs
 * anything (no console spam).
 */

import React, { useCallback, useEffect, useState } from "react";

/** Latency at or above which a healthy provider reads as slow/degraded. */
export const SLOW_LATENCY_MS = 5_000;

/** How often the strip re-polls the health endpoint. */
export const HEALTH_POLL_INTERVAL_MS = 60_000;

/** The health API's per-provider entry, as it arrives over the wire. */
export interface ProviderHealthEntry {
  id: string;
  ok: boolean;
  latencyMs: number | null;
  checkedAt: number;
  error?: string;
  checking?: boolean;
}

export type ProviderDotTone = "ok" | "slow" | "down" | "unknown";

/**
 * Map one provider's health entry to its dot tone. A provider with no keys
 * configured is "unknown" (grey), not down — it was never set up, so it
 * cannot be failing.
 */
export function providerDotTone(entry: ProviderHealthEntry): ProviderDotTone {
  if (entry.checking) return "unknown";
  if (!entry.ok) {
    if (entry.error === "No keys configured") return "unknown";
    return "down";
  }
  if (entry.latencyMs !== null && entry.latencyMs >= SLOW_LATENCY_MS) return "slow";
  return "ok";
}

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? "—" : `${Math.round(latencyMs)} ms`;
}

function formatCheckedAt(checkedAt: number): string {
  return checkedAt ? new Date(checkedAt).toLocaleTimeString() : "never";
}

/** Hover text for one dot: provider name, status, latency, last check time. */
export function providerDotTitle(entry: ProviderHealthEntry): string {
  const tone = providerDotTone(entry);
  switch (tone) {
    case "ok":
      return `${entry.id} · healthy · ${formatLatency(entry.latencyMs)} · checked ${formatCheckedAt(entry.checkedAt)}`;
    case "slow":
      return `${entry.id} · slow · ${formatLatency(entry.latencyMs)} · checked ${formatCheckedAt(entry.checkedAt)}`;
    case "down":
      return `${entry.id} · down · ${entry.error ?? "check failed"} · checked ${formatCheckedAt(entry.checkedAt)}`;
    case "unknown":
      return entry.checking
        ? `${entry.id} · checking…`
        : `${entry.id} · not configured`;
  }
}

const TONE_CLASS: Record<ProviderDotTone, string> = {
  ok: "bg-emerald-400",
  slow: "bg-amber-400",
  down: "bg-red-400",
  unknown: "bg-zinc-500",
};

/**
 * Strict shape check on the health endpoint's payload. Returns the entries,
 * or null when the payload is not the expected shape (a poll failure, not a
 * crash).
 */
export function parseHealthResponse(body: unknown): ProviderHealthEntry[] | null {
  if (typeof body !== "object" || body === null) return null;
  const providers = (body as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return null;
  const entries: ProviderHealthEntry[] = [];
  for (const provider of providers) {
    if (typeof provider !== "object" || provider === null) return null;
    const record = provider as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.ok !== "boolean") return null;
    if (typeof record.checkedAt !== "number") return null;
    if (record.latencyMs !== null && typeof record.latencyMs !== "number") return null;
    entries.push({
      id: record.id,
      ok: record.ok,
      latencyMs: record.latencyMs as number | null,
      checkedAt: record.checkedAt,
      error: typeof record.error === "string" ? record.error : undefined,
      checking: record.checking === true,
    });
  }
  return entries;
}

/**
 * One poll round against the health endpoint. Returns the entries, or null
 * on any failure (HTTP error, malformed payload, thrown fetch). Never throws
 * and never logs — a failed poll degrades to grey dots, silently.
 */
export async function fetchProviderHealth(
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderHealthEntry[] | null> {
  try {
    const res = await fetchImpl("/api/providers/health", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return parseHealthResponse(await res.json());
  } catch {
    return null;
  }
}

export interface ProviderHealthDotsProps {
  /** Last-known entries, or null when no poll has ever succeeded. */
  providers: ProviderHealthEntry[] | null;
  /** True when the latest poll failed: every dot renders grey. */
  failed: boolean;
  /** Jump to Settings > Providers. */
  onOpenProviders: () => void;
}

/** At most this many dots render; the rest collapse into a "+N" label. */
const MAX_DOTS = 10;

function summarize(entries: ProviderHealthEntry[], failed: boolean): string {
  if (failed) return "Provider health unavailable";
  if (entries.length === 0) return "Checking provider health…";
  const counts = { ok: 0, slow: 0, down: 0, unknown: 0 };
  for (const entry of entries) counts[providerDotTone(entry)] += 1;
  const parts: string[] = [];
  if (counts.ok > 0) parts.push(`${counts.ok} healthy`);
  if (counts.slow > 0) parts.push(`${counts.slow} slow`);
  if (counts.down > 0) parts.push(`${counts.down} down`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} unconfigured`);
  return `Providers: ${parts.join(", ")}`;
}

/**
 * Pure presentational strip: one status dot per provider. Kept separate from
 * the polling container so every state renders deterministically in tests
 * (static renders never run effects).
 */
export function ProviderHealthDots({ providers, failed, onOpenProviders }: ProviderHealthDotsProps) {
  const entries = providers ?? [];
  // Nothing known and no failure yet: a single grey "checking" dot keeps the
  // header layout stable while the first poll is in flight. Nothing known
  // and the poll failed: the same single grey dot, labelled unavailable.
  const visible: { id: string; tone: ProviderDotTone; title: string; checking: boolean }[] =
    entries.length > 0
      ? entries.slice(0, MAX_DOTS).map((entry) => ({
          id: entry.id,
          tone: failed ? "unknown" : providerDotTone(entry),
          title: failed ? `${entry.id} · health unavailable` : providerDotTitle(entry),
          checking: !failed && entry.checking === true,
        }))
      : [
          {
            id: "unknown",
            tone: "unknown" as const,
            title: failed ? "Provider health unavailable" : "Checking provider health…",
            checking: !failed,
          },
        ];
  const overflow = Math.max(0, entries.length - MAX_DOTS);
  // A successful poll with zero providers means the user has none at all:
  // there is nothing to show.
  if (providers !== null && providers.length === 0 && !failed) return null;

  return (
    <button
      type="button"
      onClick={onOpenProviders}
      data-testid="provider-health-strip"
      aria-label="Provider health — open Providers settings"
      title={`${summarize(entries, failed)} — open Providers settings`}
      className="press neo-pill hidden min-[420px]:flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[var(--mute)] hover:text-[var(--fg)]"
    >
      {visible.map((dot) => (
        <span
          key={dot.id}
          data-testid="provider-health-dot"
          data-provider-id={dot.id}
          data-tone={dot.tone}
          title={dot.title}
          aria-hidden
          className={`h-2 w-2 rounded-full ${TONE_CLASS[dot.tone]}${dot.checking ? " animate-pulse" : ""}`}
        />
      ))}
      {overflow > 0 && (
        <span className="text-[10px] font-medium text-[var(--mute)]" aria-hidden>
          +{overflow}
        </span>
      )}
    </button>
  );
}

export interface ProviderHealthStripProps {
  /** Jump to Settings > Providers. */
  onOpenProviders: () => void;
}

/**
 * Polling container: fetches GET /api/providers/health on mount and every
 * 60s. On a failed poll it keeps the last-known list (rendered grey) instead
 * of flashing the strip away; with no list yet it shows one grey dot.
 */
export function ProviderHealthStrip({ onOpenProviders }: ProviderHealthStripProps) {
  const [providers, setProviders] = useState<ProviderHealthEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const next = await fetchProviderHealth();
    if (next === null) {
      setFailed(true);
      return;
    }
    setProviders(next);
    setFailed(false);
  }, []);

  useEffect(() => {
    void load();
    // Re-poll while the header is mounted so a key that dies shows up.
    const timer = setInterval(() => void load(), HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return <ProviderHealthDots providers={providers} failed={failed} onOpenProviders={onOpenProviders} />;
}

export default ProviderHealthStrip;
