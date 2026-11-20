// t14r — toast model + reducer.
//
// Pure, dependency-free state logic for the dismissible toast UI. Kept outside the
// React components so it is unit-testable under lib/**/*.test.ts and importable by
// both the minimalist-ui app and any future surface.

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

/** Immutable reducer over the visible toast list. */
export function toastReducer(state: readonly Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case "add":
      return [...state, action.toast];
    case "dismiss":
      return state.filter((toast) => toast.id !== action.id);
  }
}

/** Friendly label for a provider/network failure before it hits the toast. */
export function describeFailure(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error && err.name === "AbortError") {
    return { message: "Run stopped", detail: "The request was cancelled." };
  }
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  const msg = (raw || "request failed").trim();
  const lower = msg.toLowerCase();

  if (/failed to fetch|networkerror|network request failed|load failed|econnrefused|enotfound|socket hang up|network error/.test(lower)) {
    return { message: "Network error", detail: "Couldn't reach the provider. Check your connection and try again." };
  }
  if (/\b401\b|unauthorized|invalid api key|incorrect api key|authentication/.test(lower)) {
    return { message: "Invalid API key", detail: "The provider rejected the API key. Check the key in Settings and try again." };
  }
  if (/\b403\b|forbidden|permission/.test(lower)) {
    return { message: "Access denied", detail: "The provider refused this request. Check the key permissions and try again." };
  }
  if (/\b429\b|rate limit|too many requests/.test(lower)) {
    return { message: "Rate limited", detail: "The provider is rate-limiting requests. Wait a moment and try again." };
  }
  if (/\b402\b|insufficient|quota|billing|payment required/.test(lower)) {
    return { message: "No credit", detail: "The provider ran out of credit or quota. Check billing for that provider." };
  }
  if (/\b404\b|not found|no such model|model .* not found/.test(lower)) {
    return { message: "Model not found", detail: "The selected model was not found on this provider. Pick another model in Settings." };
  }
  if (/\b5\d\d\b|server error|internal error|overloaded|unavailable/.test(lower)) {
    return { message: "Server error", detail: "The provider had a server error. Try again in a moment." };
  }

  return { message: "Provider error", detail: msg.length > 220 ? `${msg.slice(0, 220)}…` : msg };
}
