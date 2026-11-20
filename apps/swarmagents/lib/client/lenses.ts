/**
 * Browser helpers for the output lenses.
 *
 * The UI picks a lens on an agent message; this module knows how to ask for
 * one, how to recognise the answer and how to keep it around so the same
 * lens on the same message never costs a second provider call in a session.
 */

import { isLensId, type LensId, type LensResult } from "../lenses/types";

/**
 * A short, stable fingerprint of a message (FNV-1a plus its length).
 *
 * The key must never hold the message itself, and it has to match the
 * server's cache semantics: one message, one lens, one answer.
 */
export function messageFingerprint(message: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < message.length; index += 1) {
    hash ^= message.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${message.length.toString(16)}-${hash.toString(16).padStart(8, "0")}`;
}

/** Client-side key for one (message, lens) pair. */
export function lensResultKey(message: string, lens: LensId): string {
  return `${lens}:${messageFingerprint(message)}`;
}

/** Answers already seen in this session, keyed by lensResultKey. */
const sessionResults = new Map<string, LensResult>();

export function rememberedLens(key: string): LensResult | undefined {
  return sessionResults.get(key);
}

export function rememberLens(key: string, result: LensResult): void {
  sessionResults.set(key, result);
  if (sessionResults.size > 100) {
    const oldest = sessionResults.keys().next().value;
    if (oldest !== undefined) sessionResults.delete(oldest);
  }
}

/** Format a lens cost for display ("$0.0012", "$0", or "—"). */
export function formatLensCost(costUsd: number | null | undefined): string {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd)) return "—";
  if (costUsd <= 0) return "$0";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}

/** True when a value looks like a lens answer from the API. */
export function isLensResult(value: unknown): value is LensResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LensResult>;
  return (
    isLensId(candidate.lens) &&
    typeof candidate.text === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.model === "string"
  );
}

/** True when a lens answer carries a mermaid diagram. */
export function hasMermaidBlock(text: string): boolean {
  return /```\s*mermaid/i.test(text ?? "");
}

export interface LensRequestInput {
  /** The agent run the message belongs to. */
  runId: string;
  lens: LensId;
  /** The agent message the lens reads. */
  message: string;
}

/**
 * Ask the server for one lens. The server owns the provider call, the cost
 * accounting and the per-user cache.
 */
export async function requestLens(
  input: LensRequestInput,
  signal?: AbortSignal,
): Promise<LensResult> {
  const res = await fetch("/api/lenses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: input.runId,
      lens: input.lens,
      message: input.message,
    }),
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const detail =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Lens failed (HTTP ${res.status})`;
    throw new Error(detail);
  }
  if (!isLensResult(body)) throw new Error("Lens returned an unexpected answer.");
  return body;
}
