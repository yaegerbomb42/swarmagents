import type { WindowEntry } from "./types";

export const ONE_MINUTE_MS = 60_000;
export const ONE_DAY_MS = 86_400_000;

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
  if (!Number.isNaN(numeric) && numeric >= 0) {
    return Math.ceil(numeric * 1000);
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
  }
  return matched ? Math.ceil(totalMs) : undefined;
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
        result.retryAfterMs = Math.max(0, parsedDate - now);
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
    if (!Number.isNaN(asNum)) {
      // Epoch milliseconds, epoch seconds, or (small values) seconds from now.
      // Some providers send a delta here; treating "30" as epoch seconds
      // would yield a 1970 reset time and un-exclude the key immediately.
      if (asNum > 1e12) result.resetAtMs = asNum;
      else if (asNum > 1e9) result.resetAtMs = asNum * 1000;
      else if (asNum >= 0) result.resetAtMs = now + Math.ceil(asNum * 1000);
    } else {
      const asDate = Date.parse(resetRaw);
      if (!Number.isNaN(asDate)) {
        result.resetAtMs = asDate;
      }
    }
  }

  return result;
}
