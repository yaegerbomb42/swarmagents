"use client";

/**
 * useEnvironment — small read-only facts the shell needs about its
 * surroundings: who is signed in, whether a model provider is set up, and
 * whether the viewport has room for two panes.
 */

import { useCallback, useEffect, useState } from "react";

export interface Me {
  id: string;
  email?: string | null;
}

/** The signed-in user (GET /api/me), or null when nobody is. Undefined while loading. */
export function useMe(): Me | null | undefined {
  const [me, setMe] = useState<Me | null>();
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/me", { signal: ctrl.signal, cache: "no-store" });
        const body = res.ok ? ((await res.json().catch(() => null)) as { user?: Me | null } | null) : null;
        if (!ctrl.signal.aborted) setMe(body?.user ?? null);
      } catch {
        if (!ctrl.signal.aborted) setMe(null);
      }
    })();
    return () => ctrl.abort();
  }, []);
  return me;
}

export interface ProviderStatus {
  /** "unknown" until the server answers (and when it cannot be reached). */
  state: "unknown" | "configured" | "missing";
  /** Providers with at least one key that are switched on. */
  count: number;
  refresh: () => void;
}

interface ProviderRow {
  keyCount?: unknown;
  enabled?: unknown;
}

/** How many of the rows from GET /api/providers can actually serve a run. */
export function countUsableProviders(rows: readonly ProviderRow[]): number {
  return rows.filter((row) => typeof row.keyCount === "number" && row.keyCount > 0 && row.enabled !== false).length;
}

/**
 * Whether the account has a model provider a run can use. Runs execute on the
 * server with the keys stored there, so only the server's list counts.
 */
export function useProviderStatus(): ProviderStatus {
  const [state, setState] = useState<ProviderStatus["state"]>("unknown");
  const [count, setCount] = useState(0);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/providers", { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { providers?: unknown } | null;
        if (ctrl.signal.aborted || !Array.isArray(body?.providers)) return;
        const usable = countUsableProviders(body.providers as ProviderRow[]);
        setCount(usable);
        setState(usable > 0 ? "configured" : "missing");
      } catch {
        // Unknown stays unknown: never tell the user to add a key on a guess.
      }
    })();
    return () => ctrl.abort();
  }, [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { state, count, refresh };
}

/** True when the viewport is wide enough for chat and stage side by side. */
export function useIsWide(query = "(min-width: 1024px)"): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function" ? true : window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return wide;
}
