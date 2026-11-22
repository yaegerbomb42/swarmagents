import type { AttemptInfo, ProviderErrorKind } from "./types";

const REDACTED = "[redacted]";

/**
 * Remove every known secret from a string. Callers must pass every key the
 * router knows about so provider error bodies can never echo a credential.
 */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

export class AbortError extends Error {
  constructor(message = "Request aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    details: {
      provider: string;
      kind: ProviderErrorKind;
      status?: number;
      retryable: boolean;
      retryAfterMs?: number;
    }
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = details.provider;
    this.kind = details.kind;
    this.status = details.status;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export class RouterError extends Error {
  readonly code: "all_failed" | "no_providers" | "aborted" | "invalid_request";
  readonly attempts: AttemptInfo[];

  constructor(
    message: string,
    code: RouterError["code"],
    attempts: AttemptInfo[] = []
  ) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.attempts = attempts;
  }
}

export function classifyStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota_exhausted";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return (
    kind === "rate_limit" ||
    kind === "auth" ||
    kind === "server" ||
    kind === "network" ||
    kind === "timeout"
  );
}

/** Statuses that should take a key out of rotation, per the router contract. */
export function isCooldownKind(kind: ProviderErrorKind): boolean {
  return (
    kind === "rate_limit" ||
    kind === "auth" ||
    kind === "server" ||
    kind === "network" ||
    kind === "timeout" ||
    kind === "quota_exhausted"
  );
}

/** Parse Retry-After as either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Coarse error class for connection-test results — the four buckets the UI
 * renders precisely ("auth", "rate-limit", "network", "unknown"). Finer
 * detail stays in the ProviderError kind and the HTTP status.
 */
export type ProbeErrorClass = "auth" | "network" | "rate-limit" | "unknown";

export interface ProbeErrorInfo {
  errorClass: ProbeErrorClass;
  /** HTTP status when the provider answered with one. */
  status?: number;
  /** The finer ProviderError kind, when the error carried one. */
  kind?: ProviderErrorKind;
}

/**
 * Classify a probe failure for display. ProviderErrors map by kind; a raw
 * fetch failure (TypeError from undici, an abort) is a network problem;
 * anything else is unknown. Never throws and never echoes key material —
 * callers pass the already-redacted error message separately.
 */
export function classifyProbeError(err: unknown): ProbeErrorInfo {
  if (err instanceof ProviderError) {
    const base: ProbeErrorInfo = {
      errorClass: "unknown",
      kind: err.kind,
      ...(err.status !== undefined ? { status: err.status } : {}),
    };
    switch (err.kind) {
      case "auth":
        return { ...base, errorClass: "auth" };
      case "rate_limit":
      case "quota_exhausted":
        return { ...base, errorClass: "rate-limit" };
      case "network":
      case "timeout":
      case "server":
        return { ...base, errorClass: "network" };
      default:
        return base;
    }
  }
  if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
    return { errorClass: "network" };
  }
  // fetch() rejects with a TypeError on DNS/connection/TLS failures.
  if (err instanceof TypeError) {
    return { errorClass: "network" };
  }
  return { errorClass: "unknown" };
}
