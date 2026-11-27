"use client";

/**
 * Guarded sessionStorage access, shared by the client hooks that keep a
 * reattach hint there (last-run id, SSE cursor). Every access tolerates a
 * missing or blocked storage (SSR, private mode): reads return undefined,
 * writes and clears are no-ops. Callers keep their own in-memory fallback.
 */

export function readSessionValue(key: string): string | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionValue(key: string, value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: the caller falls back to its in-memory state.
  }
}

export function clearSessionValue(key: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}
