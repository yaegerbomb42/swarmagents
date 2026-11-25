/**
 * Turn-efficiency deduplication: unchanged-file re-read short-circuiting and
 * redundant back-to-back verification coalescing.
 *
 * Ported from vendor/omnexx/src/agent/redundant-read.ts.
 */

/** Canonical identity for a read slice (`path:start-end[:a]`). */
export function readSliceKey(
  filePath: string,
  start?: number,
  end?: number,
  anchors?: boolean,
): string {
  const s = start ?? 1;
  const e = end ?? Number.MAX_SAFE_INTEGER;
  return `${filePath}:${String(s)}-${String(e)}${anchors ? ":a" : ""}`;
}

/**
 * Tracks file slices read during a run. A repeat of the exact slice with no
 * mutating tool call in between is flagged as redundant; mutating calls
 * invalidate affected paths (or the whole cache).
 */
export class RedundantReadTracker {
  private readonly seen = new Map<string, Set<string>>();
  private redundant = 0;
  private savedTokens = 0;

  /**
   * Register `sliceKey` for `filePath`. Returns `true` when that exact slice
   * is already in context (caller can short-circuit); `false` on first read.
   */
  record(filePath: string, sliceKey: string): boolean {
    let slices = this.seen.get(filePath);
    if (!slices) {
      slices = new Set<string>();
      this.seen.set(filePath, slices);
    }
    if (slices.has(sliceKey)) {
      this.redundant += 1;
      return true;
    }
    slices.add(sliceKey);
    return false;
  }

  /** Record estimated tokens saved from a short-circuited read. */
  noteSavedTokens(tokens: number): void {
    this.savedTokens += Math.max(0, tokens);
  }

  /** Invalidate cached slices for specific paths, or all paths when omitted. */
  invalidate(paths?: readonly string[]): void {
    if (!paths || paths.length === 0) {
      this.seen.clear();
      return;
    }
    for (const p of paths) this.seen.delete(p);
  }

  get redundantReads(): number {
    return this.redundant;
  }

  get tokensSaved(): number {
    return this.savedTokens;
  }

  snapshot(): { redundantReads: number; tokensSaved: number } {
    return { redundantReads: this.redundant, tokensSaved: this.savedTokens };
  }
}

/** Normalize a verification command for identity comparison. */
export function normalizeVerifyCommand(cmd: string): string {
  return cmd
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:npx|bunx|pnpm|yarn)\s+/, "");
}

/**
 * Coalesces identical read-only verification commands run consecutively with
 * zero mutating tools in between.
 */
export class VerificationCoalescer {
  private lastCmd = "";
  private lastSeq = -1;

  decide(cmd: string, seq: number, mutatingSeq: number): "run" | "skip" {
    const n = normalizeVerifyCommand(cmd);
    if (!n) return "run";
    const sameAsPrevious = n === this.lastCmd && seq === this.lastSeq + 1;
    const noMutationsSince = mutatingSeq < seq;
    if (sameAsPrevious && noMutationsSince) return "skip";
    this.lastCmd = n;
    this.lastSeq = seq;
    return "run";
  }

  /** A mutating tool ran: the next verification command must execute for real. */
  invalidate(): void {
    this.lastCmd = "";
    this.lastSeq = -1;
  }
}
