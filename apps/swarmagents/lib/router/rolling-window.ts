import type { WindowEntry } from "./types";

export const ONE_MINUTE_MS = 60_000;
export const ONE_DAY_MS = 86_400_000;

/**
 * Ceiling for provider-supplied retry/reset delays. These values come from
 * upstream response headers, so they are untrusted input: without a bound,
 * `Retry-After: Infinity` (or an overflowing duration like `999999999h`)
 * excludes a key forever. Anything at or beyond a day is treated as a day.
 */
const MAX_RETRY_AFTER_MS = ONE_DAY_MS;

export function pruneWindow(entries: WindowEntry[], windowMs: number, now: number): WindowEntry[] {
  const cutoff = now - windowMs;
  let firstValid = 0;
  while (firstValid < entries.length && entries[firstValid]!.ts <= cutoff) {
    firstValid++;
  }
  return firstValid === 0 ? entries : entries.slice(firstValid);
}

export function sumWindow(entries: WindowEntry[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.ts <= cutoff) break;
    total += entry.amount;
  }
  return total;
}

export function recordWindowUsage(
  entries: WindowEntry[],
  windowMs: number,
  now: number,
  amount: number,
): WindowEntry[] {
  const pruned = pruneWindow(entries, windowMs, now);
  if (amount <= 0) return pruned;
  return [...pruned, { ts: now, amount }];
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export interface ParsedRateLimitHeaders {
  retryAfterMs?: number;
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  resetAtMs?: number;
}

function normalizeHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && v.trim() !== "") {
      out[k.toLowerCase()] = v.trim();
    }
  }
  return out;
}

function parseDurationStringToMs(raw: string): number | undefined {
  const numeric = Number(raw);
  // Number("Infinity") and Number("1e309") are >= 0 but not finite: without
  // the finite check they would exclude the key forever. Clamp as well —
  // numeric * 1000 can overflow to Infinity for large finite inputs.
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.min(Math.ceil(numeric * 1000), MAX_RETRY_AFTER_MS);
  }
  // Support formats like "12s", "500ms", "2m30s"
  let totalMs = 0;
  let matched = false;
  const regex = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    matched = true;
    const val = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit === "ms") totalMs += val;
    else if (unit === "s") totalMs += val * 1000;
    else if (unit === "m") totalMs += val * 60_000;
    else if (unit === "h") totalMs += val * 3_600_000;
    // Huge values (or a digit string long enough to parse as Infinity) must
    // not produce an unbounded exclusion.
    if (totalMs >= MAX_RETRY_AFTER_MS) return MAX_RETRY_AFTER_MS;
  }
  return matched ? Math.min(Math.ceil(totalMs), MAX_RETRY_AFTER_MS) : undefined;
}

export function parseRateLimitHeaders(
  headers: Record<string, string | undefined> | undefined,
  now: number,
): ParsedRateLimitHeaders {
  const h = normalizeHeaders(headers);
  const result: ParsedRateLimitHeaders = {};

  const retryAfter = h["retry-after"] ?? h["x-ratelimit-reset-requests"];
  if (retryAfter) {
    const durationMs = parseDurationStringToMs(retryAfter);
    if (durationMs !== undefined) {
      result.retryAfterMs = durationMs;
    } else {
      const parsedDate = Date.parse(retryAfter);
      if (!Number.isNaN(parsedDate)) {
        result.retryAfterMs = Math.min(Math.max(0, parsedDate - now), MAX_RETRY_AFTER_MS);
      }
    }
  }

  const limitReq = h["x-ratelimit-limit-requests"];
  if (limitReq && !Number.isNaN(Number(limitReq))) {
    result.limitRequests = Math.max(1, Math.floor(Number(limitReq)));
  }

  const remReq = h["x-ratelimit-remaining-requests"];
  if (remReq && !Number.isNaN(Number(remReq))) {
    result.remainingRequests = Math.max(0, Math.floor(Number(remReq)));
  }

  const limitTok = h["x-ratelimit-limit-tokens"];
  if (limitTok && !Number.isNaN(Number(limitTok))) {
    result.limitTokens = Math.max(1, Math.floor(Number(limitTok)));
  }

  const remTok = h["x-ratelimit-remaining-tokens"];
  if (remTok && !Number.isNaN(Number(remTok))) {
    result.remainingTokens = Math.max(0, Math.floor(Number(remTok)));
  }

  const resetRaw = h["x-ratelimit-reset"];
  if (resetRaw) {
    const asNum = Number(resetRaw);
    // Finite check first: "Infinity"/"1e309" would otherwise satisfy the
    // epoch-milliseconds branch and exclude the key forever.
    if (Number.isFinite(asNum)) {
      // Epoch milliseconds, epoch seconds, or (small values) seconds from now.
      // Some providers send a delta here; treating "30" as epoch seconds
      // would yield a 1970 reset time and un-exclude the key immediately.
      const candidate =
        asNum > 1e12
          ? asNum
          : asNum > 1e9
            ? asNum * 1000
            : asNum >= 0
              ? now + Math.ceil(asNum * 1000)
              : undefined;
      if (candidate !== undefined) {
        result.resetAtMs = Math.min(candidate, now + MAX_RETRY_AFTER_MS);
      }
    } else {
      const asDate = Date.parse(resetRaw);
      if (!Number.isNaN(asDate)) {
        result.resetAtMs = Math.min(asDate, now + MAX_RETRY_AFTER_MS);
      }
    }
  }

  return result;
}
