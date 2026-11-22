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

export interface FirstRunSetupInput {
  /** Server provider status; "unknown" until the server answers (or when it cannot be reached). */
  providerState: ProviderStatus["state"];
  /** The API answered 401; the signed-out notice owns that state. */
  signedOut: boolean;
  /** The session's first poll has answered. */
  ready: boolean;
  /** The conversation list has loaded, so an empty list is a fact, not a guess. */
  threadsReady: boolean;
  /** Runs in the open conversation. */
  turns: number;
  /** Conversations on the account. */
  threads: number;
}

export interface FirstRunSetup {
  /** No usable provider: a run cannot start, so sending stays blocked. */
  needsProvider: boolean;
  /** A fresh account (no runs, no conversations) with no provider: route to setup. */
  firstRun: boolean;
}

/**
 * What a zero-provider account sees instead of a run that errors (FIX-43).
 *
 * `needsProvider` is true only on a confirmed "missing" — never on
 * "unknown", for the same reason `useProviderStatus` stays unknown on a
 * failed fetch: blocking the composer on a guess would flash a setup wall
 * at accounts that do have a key. Signed-out visitors are excluded; their
 * notice and blocked reason already say what to do.
 *
 * `firstRun` additionally requires a fresh account (no runs, no
 * conversations, both lists actually loaded): that is the just-signed-up
 * case the workspace routes straight to provider setup. An established
 * account that removed its only provider gets the blocked composer and
 * the notice, but is not yanked into Settings.
 */
export function firstRunSetup(input: FirstRunSetupInput): FirstRunSetup {
  const needsProvider = input.providerState === "missing" && !input.signedOut;
  const firstRun =
    needsProvider && input.ready && input.threadsReady && input.turns === 0 && input.threads === 0;
  return { needsProvider, firstRun };
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
