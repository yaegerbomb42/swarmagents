// t14r — toast model + reducer.
//
// Pure, dependency-free state logic for the dismissible toast UI. Kept outside the
// React components so it is unit-testable under lib/**/*.test.ts and importable by
// both the minimalist-ui app and any future surface. The only import is the
// secret-shape patterns from the harness redactor (itself dependency-free),
// so error text shown in toasts can never leak credentials.

import { SECRET_PATTERNS } from "../harness/redact";

export type ToastTone = "info" | "error" | "success";

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
  /** Optional second line (e.g. provider name, detail). */
  detail?: string;
  /** TTL in ms; omit for a persistent toast (only manual dismiss). */
  ttlMs?: number;
}

export type ToastAction =
  | { type: "add"; toast: Toast }
  | { type: "dismiss"; id: string };

/** Cap active toasts so error storms cannot unbounded-stack the UI. */
export const MAX_TOASTS = 8;

function isNamedError(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}

/** True when `code` appears in an HTTP/status context (not an unrelated number). */
function mentionsHttpStatus(lower: string, code: string): boolean {
  // "HTTP 401", "status: 401", "status 401"
  if (new RegExp(`\\b(?:http(?:\\/[\\d.]*)?|status)\\b[^\\d]{0,16}\\b${code}\\b`, "i").test(lower)) {
    return true;
  }
  // "401 Unauthorized" — digit code followed by a reason phrase
  if (new RegExp(`\\b${code}\\b\\s+[A-Za-z]`).test(lower)) {
    return true;
  }
  // Bare code alone (e.g. message === "401")
  return new RegExp(`^${code}$`).test(lower.trim());
}

function mentionsHttp5xx(lower: string): boolean {
  if (/\b(?:http(?:\/[\d.]*)?|status)\b[^\d]{0,16}\b5\d\d\b/.test(lower)) return true;
  // "500 Internal Server Error" / "502 Bad Gateway" — reason phrase after code
  if (/\b5\d\d\b\s+(?:internal|bad|service|gateway|not|error|unavailable)/.test(lower)) return true;
  return false;
}

/** Immutable reducer over the visible toast list. */
export function toastReducer(state: readonly Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case "add": {
      const withoutDup = state.filter((toast) => toast.id !== action.toast.id);
      const next = [...withoutDup, action.toast];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    }
    case "dismiss":
      return state.filter((toast) => toast.id !== action.id);
  }
}

/**
 * Replace known secret shapes (API keys, tokens, Bearer credentials) with
 * [REDACTED]. Uses String.replace, which resets a global regex's lastIndex
 * before matching, so repeated calls never skip matches.
 */
function scrubSecrets(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Friendly label for a provider/network failure before it hits the toast. */
export function describeFailure(err: unknown): { message: string; detail?: string } {
  if (isNamedError(err, "AbortError")) {
    return { message: "Run stopped", detail: "The request was cancelled." };
  }
  if (isNamedError(err, "TimeoutError")) {
    return { message: "Timed out", detail: "The request took too long. Try again." };
  }
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  const msg = (raw || "request failed").trim();
  const lower = msg.toLowerCase();

  if (/failed to fetch|networkerror|network request failed|load failed|econnrefused|enotfound|socket hang up|network error/.test(lower)) {
    return { message: "Network error", detail: "Couldn't reach the provider. Check your connection and try again." };
  }
  if (mentionsHttpStatus(lower, "401") || /unauthorized|invalid api key|incorrect api key|authentication/.test(lower)) {
    return { message: "Invalid API key", detail: "The provider rejected the API key. Check the key in Settings and try again." };
  }
  if (mentionsHttpStatus(lower, "403") || /forbidden|permission/.test(lower)) {
    return { message: "Access denied", detail: "The provider refused this request. Check the key permissions and try again." };
  }
  if (mentionsHttpStatus(lower, "429") || /rate limit|too many requests/.test(lower)) {
    return { message: "Rate limited", detail: "The provider is rate-limiting requests. Wait a moment and try again." };
  }
  if (mentionsHttpStatus(lower, "402") || /insufficient|quota|billing|payment required/.test(lower)) {
    return { message: "No credit", detail: "The provider ran out of credit or quota. Check billing for that provider." };
  }
  // Model-specific only — generic "file/session not found" must not land here.
  if (
    /\bno such model\b/.test(lower) ||
    /\bmodel\b.{0,60}\bnot found\b/.test(lower) ||
    /\bnot found\b.{0,60}\bmodel\b/.test(lower) ||
    (mentionsHttpStatus(lower, "404") && /\bmodel\b/.test(lower))
  ) {
    return { message: "Model not found", detail: "The selected model was not found on this provider. Pick another model in Settings." };
  }
  if (mentionsHttp5xx(lower) || /server error|internal error|overloaded|unavailable/.test(lower)) {
    return { message: "Server error", detail: "The provider had a server error. Try again in a moment." };
  }

  // Fallback: echo the raw message, but scrub secret-shaped values first so
  // error text shown in toasts cannot leak credentials, then truncate.
  const detail = scrubSecrets(msg);
  return { message: "Provider error", detail: detail.length > 220 ? `${detail.slice(0, 220)}…` : detail };
}
