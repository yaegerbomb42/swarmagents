/**
 * Shared base for pending human-interaction stores (handoffs, questions).
 *
 * Both stores are the same machine: an in-memory map of pending items, a
 * waiter promise per item, an unref'd TTL timer per pending item, an atomic
 * JSON mirror on disk (newest-first, capped at MAX_PERSISTED), and
 * corrupt-mirror recovery. One implementation keeps timer/persistence fixes
 * in sync instead of drifting between two copies.
 *
 * Restored pending items get a fresh waiter and TTL timer on load, so a
 * server restart never leaves an item stuck in pending forever. `clear()`
 * resolves outstanding waiters as cancelled so test teardown never leaves
 * dangling promises. `listPending()` hides items whose TTL elapsed (the
 * armed timer still expires them), so callers never see a stale pending
 * card. A late `waitFor()` on a decided item reports the stored outcome
 * through `decidedOutcome` instead of a wrong "cancelled".
 */

import fs from "node:fs";
import path from "node:path";
import { recordAudit, type AuditAction } from "../audit";
import { atomicWriteFile } from "../atomic-write";

export type InteractionStatus = "pending" | "answered" | "expired" | "cancelled";

export interface BasePendingInteraction {
  id: string;
  runId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  status: InteractionStatus;
}

export interface PendingStoreConfig<
  TItem extends BasePendingInteraction,
  TOutcome extends { status: InteractionStatus },
> {
  filePath: string;
  /** Disable disk persistence (tests that don't care). */
  persist?: boolean;
  maxPersisted?: number;
  now?: () => number;
  auditExpireAction: AuditAction;
  /** Validate/normalize one persisted entry; return null to drop it. */
  normalize: (raw: unknown, nowMs: number) => TItem | null;
  /** Extra per-item work on expiry (e.g. stamping an answeredAt). */
  onExpire?: (item: TItem, nowMs: number) => void;
  expiredOutcome: () => TOutcome;
  cancelledOutcome: () => TOutcome;
  /**
   * Outcome for a late waitFor() on an already-decided item. When absent,
   * waitFor falls back to expired/cancelled by status. Subclasses should
   * pass one so a decided item reports its real outcome (e.g. an answered
   * handoff reports "answered", not "cancelled").
   */
  decidedOutcome?: (item: TItem) => TOutcome;
  /**
   * Prune decided items older than this from memory on save (in addition
   * to the MAX_PERSISTED cap). Handoffs keep decided items 24h so a late
   * waiter still gets its outcome; older ones are dropped.
   */
  decidedRetentionMs?: number;
}

const DEFAULT_MAX_PERSISTED = 500;

interface WaitEntry<TOutcome> {
  promise: Promise<TOutcome>;
  resolve: (outcome: TOutcome) => void;
}

export class PendingInteractionStore<
  TItem extends BasePendingInteraction,
  TOutcome extends { status: InteractionStatus },
> {
  private readonly items = new Map<string, TItem>();
  private readonly waiters = new Map<string, WaitEntry<TOutcome>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly filePath: string;
  private readonly persist: boolean;
  private readonly maxPersisted: number;
  /** Subclasses use this to stamp createdAt/expiresAt (see create()). */
  protected readonly now: () => number;

  constructor(private readonly config: PendingStoreConfig<TItem, TOutcome>) {
    this.filePath = config.filePath;
    this.persist = config.persist !== false;
    this.maxPersisted = config.maxPersisted ?? DEFAULT_MAX_PERSISTED;
    this.now = config.now ?? Date.now;
    if (this.persist) this.load();
  }

  /**
   * Register a fresh pending item: map entry, waiter promise, TTL timer,
   * then persist. If the id already exists, the prior waiter is settled as
   * cancelled and its timer cleared before the replacement takes over.
   */
  protected createPending(item: TItem, ttlMs: number): TItem {
    const existing = this.items.get(item.id);
    if (existing && existing.status === "pending") {
      this.clearTimer(item.id);
      this.resolveWaiter(item.id, this.config.cancelledOutcome());
    }
    this.items.set(item.id, item);

    let resolve!: (outcome: TOutcome) => void;
    const promise = new Promise<TOutcome>((res) => {
      resolve = res;
    });
    this.waiters.set(item.id, { promise, resolve });
    this.armTimer(item.id, ttlMs);
    this.save();
    return item;
  }

  get(id: string): TItem | undefined {
    return this.items.get(id);
  }

  /** Promise that settles when the item is resolved, cancelled or expires. */
  waitFor(id: string): Promise<TOutcome> {
    const waiter = this.waiters.get(id);
    if (waiter) return waiter.promise;
    const existing = this.items.get(id);
    if (existing && existing.status !== "pending") {
      // Decided already (its waiter was deleted on settle): report the
      // stored outcome instead of a wrong "cancelled".
      if (this.config.decidedOutcome) return Promise.resolve(this.config.decidedOutcome(existing));
      if (existing.status === "expired") return Promise.resolve(this.config.expiredOutcome());
      return Promise.resolve(this.config.cancelledOutcome());
    }
    return Promise.resolve(this.config.cancelledOutcome());
  }

  /**
   * Resolve a pending item through `mutate` (which sets its terminal
   * status and outcome). Idempotent: the first resolution wins; resolving
   * a missing id returns undefined, a settled item returns as-is.
   */
  protected settle(
    id: string,
    mutate: (item: TItem, nowMs: number) => TOutcome,
  ): TItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    if (item.status !== "pending") return item;
    this.clearTimer(id);
    const outcome = mutate(item, this.now());
    this.resolveWaiter(id, outcome);
    this.save();
    return item;
  }

  /** Cancel every pending item for a run. Persists only when something changed. */
  cancelPendingForRun(runId: string): void {
    let changed = false;
    for (const item of this.items.values()) {
      if (item.runId === runId && item.status === "pending") {
        item.status = "cancelled";
        this.clearTimer(item.id);
        this.resolveWaiter(item.id, this.config.cancelledOutcome());
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Pending items, newest first, optionally scoped to one user/run. */
  listPending(filter: { userId?: string; runId?: string } = {}): TItem[] {
    const nowMs = this.now();
    const out: TItem[] = [];
    for (const item of this.items.values()) {
      if (item.status !== "pending") continue;
      // Wall-clock guard: a pending item whose TTL elapsed (the timer
      // never fired, or the entry was restored without one) is stale and
      // must not be shown as awaiting the user. The guard only hides it;
      // the armed timer still expires it.
      if (item.expiresAt <= nowMs) continue;
      if (filter.userId && item.userId !== filter.userId) continue;
      if (filter.runId && item.runId !== filter.runId) continue;
      out.push(item);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Test/reset hook: drop all in-memory state (does not delete the file). */
  clear(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    for (const id of [...this.waiters.keys()]) {
      this.resolveWaiter(id, this.config.cancelledOutcome());
    }
    this.items.clear();
  }

  private armTimer(id: string, delayMs: number): void {
    const timer = setTimeout(() => this.expire(id), Math.max(0, delayMs));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private expire(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status !== "pending") return;
    this.timers.delete(id);
    const nowMs = this.now();
    item.status = "expired";
    this.config.onExpire?.(item, nowMs);
    // Audit persistence never throws; a failed audit must not block expiry.
    recordAudit({
      user: item.userId,
      action: this.config.auditExpireAction,
      target: item.id,
      result: "success",
    });
    this.resolveWaiter(id, this.config.expiredOutcome());
    this.save();
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private resolveWaiter(id: string, outcome: TOutcome): void {
    const entry = this.waiters.get(id);
    if (entry) {
      this.waiters.delete(id);
      entry.resolve(outcome);
    }
  }

  private load(): void {
    let parsed: unknown;
    try {
      if (!fs.existsSync(this.filePath)) return;
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err) {
      // A corrupt file must never crash the runtime; pending items are
      // best-effort and the in-memory store still works.
      console.error("[pending-store] could not read persisted items:", err instanceof Error ? err.message : err);
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [];
    const nowMs = this.now();
    for (const raw of list) {
      const item = this.config.normalize(raw, nowMs);
      if (!item) continue;
      this.items.set(item.id, item);
      if (item.status !== "pending") continue;
      if (item.expiresAt <= nowMs) {
        // TTL elapsed while the server was down: expired, not resurrected.
        item.status = "expired";
        this.config.onExpire?.(item, nowMs);
        continue;
      }
      let resolve!: (outcome: TOutcome) => void;
      const promise = new Promise<TOutcome>((res) => {
        resolve = res;
      });
      this.waiters.set(item.id, { promise, resolve });
      this.armTimer(item.id, item.expiresAt - nowMs);
    }
  }

  private save(): void {
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const nowMs = this.now();
      // Prune decided items older than the retention bound from memory
      // too: disk serialization already trimmed them, but the in-memory
      // map grew without bound.
      const retentionMs = this.config.decidedRetentionMs;
      if (retentionMs !== undefined) {
        for (const [id, item] of this.items) {
          if (item.status !== "pending" && nowMs - item.createdAt > retentionMs) {
            this.items.delete(id);
            this.waiters.delete(id);
            this.clearTimer(id);
          }
        }
      }
      // Cap the in-memory map at maxPersisted, always keeping pending
      // items: drop the oldest decided items beyond the cap.
      const sorted = [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
      const keep = new Set<string>();
      for (const item of sorted) {
        if (item.status === "pending" || keep.size < this.maxPersisted) keep.add(item.id);
      }
      for (const id of [...this.items.keys()]) {
        if (!keep.has(id)) {
          this.items.delete(id);
          this.waiters.delete(id);
          this.clearTimer(id);
        }
      }
      const all = [...this.items.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, this.maxPersisted);
      atomicWriteFile(this.filePath, JSON.stringify(all));
    } catch (err) {
      console.error("[pending-store] could not persist items:", err instanceof Error ? err.message : err);
    }
  }

}
