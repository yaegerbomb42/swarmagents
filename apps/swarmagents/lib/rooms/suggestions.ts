/**
 * Guest prompt suggestions for live share rooms.
 *
 * A guest visiting a share link can drop a prompt suggestion for the owner.
 * Suggestions are non-executing: they land in a per-owner FIFO pending queue
 * and only enter the owner's run queue when the owner explicitly runs one.
 * The pending queue is bounded by SWARM_MAX_QUEUED (the same knob that bounds
 * the owner's own run queue) and guest input is validated and rate-limited so
 * a cold public link cannot be flooded.
 *
 * Backing is per-process in-memory state, exactly like the run manager's
 * queue — it is not durable across restarts, and it never writes to the
 * owner's account directory.
 */

import { randomUUID } from "node:crypto";

/** Default pending-suggestion queue depth (mirrors the run queue default). */
export const DEFAULT_MAX_QUEUED = 3;

/** Max characters in a guest suggestion prompt. */
export const MAX_SUGGESTION_LEN = 8000;

/** Rate-limit window over which a guest may submit suggestions to one owner. */
export const RATE_WINDOW_MS = 60_000;

/** Max accepted suggestions per owner per rate-limit window. */
export const MAX_SUGGESTIONS_PER_WINDOW = 5;

/** Queue depth from SWARM_MAX_QUEUED (default 3); invalid values fall back. */
export function maxQueuedFromEnv(env: { [key: string]: string | undefined } = process.env): number {
  const raw = env.SWARM_MAX_QUEUED?.trim();
  if (!raw) return DEFAULT_MAX_QUEUED;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return DEFAULT_MAX_QUEUED;
  return n;
}

export interface Suggestion {
  id: string;
  prompt: string;
  createdAt: number;
}

export interface AddSuggestionResult {
  accepted: boolean;
  suggestion?: Suggestion;
  /** The configured queue depth when `accepted` is false because it is full. */
  limit?: number;
  error?: string;
}

export interface RemoveSuggestionResult {
  ok: boolean;
  suggestion?: Suggestion;
}

interface OwnerState {
  /** FIFO pending suggestions, oldest first. */
  queue: Suggestion[];
  /** Timestamps of accepted suggestions used for rate limiting. */
  acceptedAt: number[];
}

export interface SuggestionsStoreOptions {
  now?: () => number;
  /** Override the queue-depth bound (defaults to SWARM_MAX_QUEUED). */
  maxQueued?: number;
  /** Rate-limit window in ms. */
  windowMs?: number;
  /** Max accepted suggestions per owner per window. */
  maxPerWindow?: number;
}

export class SuggestionsStore {
  private readonly byOwner = new Map<string, OwnerState>();
  private readonly maxQueued: number;
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly now: () => number;

  constructor(options: SuggestionsStoreOptions = {}) {
    this.maxQueued = Math.max(0, options.maxQueued ?? maxQueuedFromEnv());
    this.windowMs = Math.max(1, options.windowMs ?? RATE_WINDOW_MS);
    this.maxPerWindow = Math.max(1, options.maxPerWindow ?? MAX_SUGGESTIONS_PER_WINDOW);
    this.now = options.now ?? Date.now;
  }

  private state(ownerId: string): OwnerState {
    let st = this.byOwner.get(ownerId);
    if (!st) {
      st = { queue: [], acceptedAt: [] };
      this.byOwner.set(ownerId, st);
    }
    return st;
  }

  private rateLimited(st: OwnerState, now: number): boolean {
    const cutoff = now - this.windowMs;
    const recent = st.acceptedAt.filter((at) => at >= cutoff);
    st.acceptedAt = recent;
    return recent.length >= this.maxPerWindow;
  }

  /**
   * Enqueue a guest suggestion for an owner. Validates and trims the prompt,
   * applies the per-owner rate limit, then appends FIFO up to the queue bound.
   * Returns an immutable result — never the live internal array.
   */
  add(ownerId: string, prompt: string): AddSuggestionResult {
    if (!ownerId || ownerId.length === 0) {
      return { accepted: false, error: "Missing owner." };
    }
    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) {
      return { accepted: false, error: "prompt is required." };
    }
    if (text.length > MAX_SUGGESTION_LEN) {
      return { accepted: false, error: "prompt too long." };
    }

    const st = this.state(ownerId);
    if (this.rateLimited(st, this.now())) {
      return { accepted: false, error: "Too many suggestions. Please wait." };
    }
    if (st.queue.length >= this.maxQueued) {
      return { accepted: false, limit: this.maxQueued, error: "Suggestion queue is full." };
    }

    const suggestion: Suggestion = {
      id: randomUUID(),
      prompt: text,
      createdAt: this.now(),
    };
    st.queue = [...st.queue, suggestion];
    st.acceptedAt = [...st.acceptedAt, suggestion.createdAt];
    return { accepted: true, suggestion: { ...suggestion } };
  }

  /** Immutable snapshot of the owner's pending suggestions, oldest first. */
  list(ownerId: string): Suggestion[] {
    const st = this.byOwner.get(ownerId);
    if (!st) return [];
    return st.queue.map((s) => ({ ...s }));
  }

  count(ownerId: string): number {
    return this.byOwner.get(ownerId)?.queue.length ?? 0;
  }

  get(ownerId: string, id: string): Suggestion | null {
    const st = this.byOwner.get(ownerId);
    if (!st) return null;
    const found = st.queue.find((s) => s.id === id);
    return found ? { ...found } : null;
  }

  /**
   * Remove (consume) a pending suggestion. Returns the removed suggestion so
   * the caller can hand it to the run manager.
   */
  remove(ownerId: string, id: string): RemoveSuggestionResult {
    const st = this.byOwner.get(ownerId);
    if (!st) return { ok: false };
    const idx = st.queue.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false };
    const [suggestion] = st.queue.slice(idx, idx + 1);
    st.queue = [...st.queue.slice(0, idx), ...st.queue.slice(idx + 1)];
    return { ok: true, suggestion: { ...suggestion } };
  }
}

// One store per process (same pattern as the runtime manager).
const g = globalThis as typeof globalThis & { __swarmSuggestionsStore?: SuggestionsStore };
export function getSuggestionsStore(): SuggestionsStore {
  if (!g.__swarmSuggestionsStore) {
    g.__swarmSuggestionsStore = new SuggestionsStore();
  }
  return g.__swarmSuggestionsStore;
}

export function setSuggestionsStoreForTesting(store: SuggestionsStore | null): void {
  g.__swarmSuggestionsStore = store ?? undefined;
}
