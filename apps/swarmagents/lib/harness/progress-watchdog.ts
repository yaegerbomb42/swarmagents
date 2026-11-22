/**
 * Remaining-gain ProgressWatchdog & git-checkpoint auto-rewinder.
 *
 * Middleware that watches every turn's observable progress signal,
 * checkpoints the working tree before risky mutations, and triggers an
 * automatic rewind-and-fork recovery when expected remaining gain
 * collapses. Deterministic, zero LLM calls, and inert when healthy:
 * observe() is pure bookkeeping plus one git snapshot every N mutating
 * turns; detection only reads the signals it is given.
 *
 * The four failure pathologies (checked in this order):
 *   a) Exact Spin: the same errorSignature for >= 3 consecutive turns.
 *   b) Diff Thrash: the file diff oscillates (state at t equals t-2).
 *   c) Read Paralysis: >= 6 consecutive read/search turns with zero new
 *      unique symbols discovered and zero edits.
 *   d) Monotonic Regression: compilerErrorCount increasing for >= 3
 *      consecutive edit turns.
 *
 * errorSignature is the canonical normalized failure hash: SHA-256 of
 * normalizeErrorSignature (defined in this module) — the same signature
 * StateLedger.recordFailureFromTurn accepts, so the Negative Constraint
 * Ledger and the watchdog converge on one failure identity instead of
 * two.
 *
 * Checkpoints are ephemeral unnamed git tree snapshots (`git write-tree`
 * against a throwaway index, so the real index and the commit history
 * are untouched). Restore is `git read-tree -u --reset <tree>`: tracked
 * files return to the snapshot; untracked (including ignored) files are
 * never touched. A rewind is a manager-level re-drive: the runner
 * cannot rewind the CLI, so when a pathology fires the watchdog halts
 * the run with a distinct marker carrying the best checkpoint and a
 * FAILED_HYPOTHESES block, and the manager restores + forks a clean
 * recovery turn. Rewinds are capped (2 Surgical / 4 Feature); past the
 * cap the verdict escalates instead of rewinding.
 *
 * Signals the watchdog cannot see degrade gracefully: a pathology whose
 * inputs are absent simply cannot fire (e.g. diff thrash needs
 * diffHash; regression needs compilerErrorCount). The runner feeds
 * tool names + result text; the oracle/manager feed test counts and
 * diff hashes through the same observe() API.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { VmExec } from "./types";

// Absolute git path from fixed, trusted dirs so host exec never relies on PATH
// resolution (Sonar S4036).
const GIT_BIN =
  ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"].find((p) => fs.existsSync(p)) ?? "/usr/bin/git";

/**
 * Strip the volatile parts of a failure (ANSI, timestamps, :line[:col]
 * suffixes, `line N`, hex addresses) so the same failure at two turns
 * normalizes identically. File paths and failing test names are kept
 * verbatim, so repeat failures dedup; repeated lines collapse; the
 * result is capped at 240 chars. The negative-constraint ledger's
 * recordFailureFromTurn consumes this same signature — it lives on its
 * own branch (PR #153) and should import this instead of keeping a
 * second copy when it lands.
 */
export function normalizeErrorSignature(raw: string): string {
  const noAnsi = raw.replace(/\[[0-9;]*m/g, "");
  const lines = noAnsi.split("\n").map((line) =>
    line
      .replace(/:\d+:\d+/g, "") // :line:col suffixes
      .replace(/:\d+\b/g, "") // :line suffixes
      .replace(/\d{1,2}:\d{2}(:\d{2})?(\.\d+)?/g, "") // timestamps
      .replace(/\bline \d+\b/gi, "")
      .replace(/0x[0-9a-fA-F]+/g, "") // hex addresses
      .trim(),
  );
  // Collapse whitespace and drop repeated lines.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (!collapsed || seen.has(collapsed)) continue;
    seen.add(collapsed);
    deduped.push(collapsed);
  }
  return deduped.join("\n").slice(0, 240);
}

/** SHA-256 hex of the normalized failure text. */
export function errorSignature(raw: string): string {
  return createHash("sha256").update(normalizeErrorSignature(raw), "utf8").digest("hex");
}

/** File paths mentioned in tool output: the discovery signal for read turns. */
const FILE_PATH_RE = /[A-Za-z0-9_.$/-]+\.(?:ts|tsx|js|jsx|mts|cts|py|go|rs|rb|java|md|json|yaml|yml|toml|css|html)\b/g;

export function extractDiscoveredSymbols(output: string): string[] {
  return [...new Set(output.match(FILE_PATH_RE) ?? [])];
}

/** Epistemic read/search tools: they cannot change the tree. */
export const READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
/** Tools that can change the tree. */
export const MUTATING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash", "Terminal", "Shell", "cmd"]);

export function isReadTool(name: string | undefined): boolean {
  return name !== undefined && READ_TOOLS.has(name);
}

export function isMutatingTool(name: string | undefined): boolean {
  return name !== undefined && MUTATING_TOOLS.has(name);
}

export interface TurnSignal {
  turn: number;
  toolName?: string;
  /** True for a pure read/search turn. */
  readOnly?: boolean;
  /** True when the turn edited the tree. */
  edited?: boolean;
  /** Normalized failure hash for this turn (undefined when the turn passed). */
  errorSignature?: string;
  testPassCount?: number;
  compilerErrorCount?: number;
  /** Content hash of the turn's diff (see oracle hashDiff helpers). */
  diffHash?: string;
  /** Symbols (file paths) this turn's reads surfaced. */
  symbolsDiscovered?: string[];
}

export type Pathology = "exact-spin" | "diff-thrash" | "read-paralysis" | "monotonic-regression";

export interface Checkpoint {
  step: number;
  treeHash: string;
  testPassCount: number;
  compilerErrorCount: number;
  diffHash: string;
  createdAt: number;
}

export interface WatchdogVerdict {
  pathology: Pathology | null;
  action: "none" | "rewind" | "escalate";
  /** Best checkpoint to rewind to (highest passes, fewest errors). */
  checkpoint?: Checkpoint;
  /** Compact block forbidding the repeated approach, for the recovery turn. */
  failedHypotheses: string[];
  rewindsUsed: number;
  maxRewinds: number;
}

/** Minimal git surface the watchdog needs; injectable for tests and the VM. */
export interface GitRunner {
  /** Snapshot the working tree; returns the tree hash. */
  writeTree(cwd: string): Promise<string>;
  /** Restore index + tracked working tree to a tree hash. */
  restoreTree(cwd: string, treeHash: string): Promise<void>;
}

/**
 * Local git runner (child_process). The snapshot uses a throwaway index
 * so the real index is never staged into and no commit is created.
 */
export function execFileGitRunner(): GitRunner {
  return {
    async writeTree(cwd: string): Promise<string> {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-watchdog-"));
      try {
        const indexFile = path.join(tmpDir, "index");
        const env = { ...process.env, GIT_INDEX_FILE: indexFile };
        execFileSync(GIT_BIN, ["add", "-A"], { cwd, env, stdio: "pipe" });
        return execFileSync(GIT_BIN, ["write-tree"], { cwd, env, stdio: "pipe", encoding: "utf8" }).trim();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    async restoreTree(cwd: string, treeHash: string): Promise<void> {
      execFileSync(GIT_BIN, ["read-tree", "-u", "--reset", treeHash], { cwd, stdio: "pipe" });
    },
  };
}

/** Git runner over the harness VmExec (commands run inside the VM). */
export function vmExecGitRunner(vm: VmExec): GitRunner {
  const run = async (
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string }> => {
    let stdout = "";
    const { exitCode } = await vm.exec(["git", ...args], {
      cwd,
      ...(env ? { env } : {}),
      onStdout: (chunk) => {
        stdout += chunk;
      },
    });
    return { exitCode, stdout };
  };
  return {
    async writeTree(cwd: string): Promise<string> {
      // Throwaway index, like the local runner: the real index is untouched.
      const indexFile = `/tmp/swarm-watchdog-index-${process.pid}-${Date.now()}`;
      const env = { GIT_INDEX_FILE: indexFile };
      try {
        const add = await run(["add", "-A"], cwd, env);
        if (add.exitCode !== 0) throw new Error(`git add -A failed with exit ${add.exitCode}`);
        const tree = await run(["write-tree"], cwd, env);
        if (tree.exitCode !== 0) throw new Error(`git write-tree failed with exit ${tree.exitCode}`);
        return tree.stdout.trim();
      } finally {
        // Best effort: the temp index is useless once the tree exists.
        await vm.exec(["rm", "-f", indexFile], { cwd }).catch(() => {});
      }
    },
    async restoreTree(cwd: string, treeHash: string): Promise<void> {
      const restored = await run(["read-tree", "-u", "--reset", treeHash], cwd);
      if (restored.exitCode !== 0) throw new Error(`git read-tree failed with exit ${restored.exitCode}`);
    },
  };
}

export type WatchdogMode = "surgical" | "feature";

export interface ProgressWatchdogOptions {
  /** Nothing is constructed or called unless true. */
  enabled?: boolean;
  mode?: WatchdogMode;
  /** Override the mode's rewind cap. */
  maxRewinds?: number;
  /** Checkpoint at most every N mutating turns (default 3). */
  checkpointEveryNTurns?: number;
  /** Working tree for git snapshots; omit for detection-only mode. */
  cwd?: string;
  /** Git runner; defaults to the local execFile runner when cwd is set. */
  git?: GitRunner;
  /** Injectable clock for tests. */
  now?: () => number;
}

const MAX_REWINDS: Record<WatchdogMode, number> = { surgical: 2, feature: 4 };
const ROLLING_WINDOW = 10;

export class ProgressWatchdog {
  private readonly maxRewinds: number;
  private readonly checkpointEveryNTurns: number;
  private readonly cwd: string | undefined;
  private readonly git: GitRunner | undefined;
  private readonly now: () => number;
  private readonly signals: TurnSignal[] = [];
  private readonly checkpoints: Checkpoint[] = [];
  private readonly seenSymbols = new Set<string>();
  private paralysisStreak = 0;
  private lastCheckpointTurn = -1;
  private rewindsUsed = 0;

  constructor(options: ProgressWatchdogOptions = {}) {
    const mode = options.mode ?? "surgical";
    this.maxRewinds = options.maxRewinds ?? MAX_REWINDS[mode];
    this.checkpointEveryNTurns = Math.max(1, options.checkpointEveryNTurns ?? 3);
    this.cwd = options.cwd;
    this.git = options.git ?? (options.cwd ? execFileGitRunner() : undefined);
    this.now = options.now ?? Date.now;
  }

  get rewindCount(): number {
    return this.rewindsUsed;
  }

  /** Best checkpoint: most passing tests, fewest compiler errors, newest wins ties. */
  bestCheckpoint(): Checkpoint | undefined {
    return [...this.checkpoints].sort(
      (a, b) =>
        b.testPassCount - a.testPassCount ||
        a.compilerErrorCount - b.compilerErrorCount ||
        b.step - a.step,
    )[0];
  }

  /**
   * Snapshot the working tree now. Best-effort: returns null (and never
   * throws) when there is no git runner or git fails — detection keeps
   * working, only rewinds are unavailable.
   */
  async checkpointNow(
    signal: Pick<TurnSignal, "turn" | "testPassCount" | "compilerErrorCount" | "diffHash">,
  ): Promise<Checkpoint | null> {
    if (!this.cwd || !this.git) return null;
    let treeHash: string;
    try {
      treeHash = await this.git.writeTree(this.cwd);
    } catch {
      return null;
    }
    const checkpoint: Checkpoint = {
      step: signal.turn,
      treeHash,
      testPassCount: signal.testPassCount ?? 0,
      compilerErrorCount: signal.compilerErrorCount ?? 0,
      diffHash: signal.diffHash ?? "",
      createdAt: this.now(),
    };
    this.checkpoints.push(checkpoint);
    this.lastCheckpointTurn = signal.turn;
    return checkpoint;
  }

  /**
   * Checkpoint the post-turn state when the turn mutated the tree and
   * the checkpoint interval has elapsed (that snapshot is the pre-state
   * of the next mutation). Async: git runs in the VM for the runner
   * wiring, so callers await this on the gate chain, never in the
   * synchronous stream path.
   */
  async maybeCheckpoint(signal: TurnSignal): Promise<Checkpoint | null> {
    const mutating = signal.edited === true || isMutatingTool(signal.toolName);
    if (!mutating || !this.cwd) return null;
    if (this.lastCheckpointTurn >= 0 && signal.turn - this.lastCheckpointTurn < this.checkpointEveryNTurns) {
      return null;
    }
    return this.checkpointNow(signal);
  }

  /**
   * Observe one turn and return the verdict. Pure detection: no git, no
   * I/O, no LLM calls. The caller checkpoints separately via
   * maybeCheckpoint() and performs rewinds via rewind().
   */
  observe(signal: TurnSignal): WatchdogVerdict {
    this.signals.push(signal);
    if (this.signals.length > ROLLING_WINDOW) this.signals.shift();
    this.trackParalysis(signal);

    const pathology = this.detect();
    const failedHypotheses = this.failedHypotheses(pathology);
    if (!pathology) {
      return { pathology: null, action: "none", failedHypotheses, rewindsUsed: this.rewindsUsed, maxRewinds: this.maxRewinds };
    }
    if (this.rewindsUsed >= this.maxRewinds) {
      return { pathology, action: "escalate", failedHypotheses: this.failedHypotheses(pathology, true), rewindsUsed: this.rewindsUsed, maxRewinds: this.maxRewinds };
    }
    return {
      pathology,
      action: "rewind",
      checkpoint: this.bestCheckpoint(),
      failedHypotheses,
      rewindsUsed: this.rewindsUsed,
      maxRewinds: this.maxRewinds,
    };
  }

  /**
   * Restore the working tree to a checkpoint. The caller (manager)
   * performs the re-drive; this only restores the tree and counts the
   * rewind against the cap.
   */
  async rewind(checkpoint: Checkpoint): Promise<void> {
    if (!this.cwd || !this.git) throw new Error("ProgressWatchdog: no git runner configured for rewind");
    await this.git.restoreTree(this.cwd, checkpoint.treeHash);
    this.rewindsUsed++;
  }

  /** Clear the signal window after a rewind so the same history cannot instantly re-fire. */
  resetAfterRewind(): void {
    this.signals.length = 0;
    this.paralysisStreak = 0;
  }

  /** Compact FAILED_HYPOTHESES block for the clean-context recovery turn. */
  failedHypotheses(pathology: Pathology | null, escalated = false): string[] {
    if (!pathology) return [];
    const recent = this.signals.slice(-3);
    let lines: string[];
    switch (pathology) {
      case "exact-spin": {
        const sig = recent[recent.length - 1]?.errorSignature ?? "unknown";
        lines = [
          `tried the failing approach 3+ times in a row (error ${sig.slice(0, 12)}) -> failed because the same verification keeps failing -> do NOT retry the same change; change the approach`,
        ];
        break;
      }
      case "diff-thrash": {
        const hashes = [...new Set(recent.map((s) => (s.diffHash ?? "").slice(0, 12)).filter(Boolean))];
        lines = [
          `tried oscillating between diff states (${hashes.join(" <-> ")}) -> failed because the change flips back and forth without progress -> do NOT retry either state; pick one direction and verify it`,
        ];
        break;
      }
      case "read-paralysis": {
        lines = [
          "tried 6+ consecutive read/search turns with no new symbols and no edits -> failed because exploration is not converging on an edit -> do NOT retry more reads; make the smallest concrete edit and verify it",
        ];
        break;
      }
      case "monotonic-regression": {
        const counts = this.editTurns()
          .slice(-3)
          .map((s) => s.compilerErrorCount)
          .join(" -> ");
        lines = [
          `tried edits while compiler errors rose (${counts}) -> failed because each edit adds errors -> do NOT retry more edits on this path; restore the best checkpoint and change approach`,
        ];
        break;
      }
    }
    if (escalated) {
      lines.push(
        `rewind cap reached (${this.rewindsUsed}/${this.maxRewinds}) -> the tree cannot be rewound again; escalate to a human or a fundamentally different approach`,
      );
    }
    return lines;
  }

  private trackParalysis(signal: TurnSignal): void {
    const readOnly = signal.readOnly === true || isReadTool(signal.toolName);
    if (!readOnly || signal.edited === true) {
      this.paralysisStreak = 0;
      return;
    }
    const discovered = signal.symbolsDiscovered ?? [];
    const fresh = discovered.filter((s) => !this.seenSymbols.has(s));
    if (fresh.length === 0) {
      this.paralysisStreak++;
    } else {
      this.paralysisStreak = 0;
      for (const s of fresh) this.seenSymbols.add(s);
    }
  }

  private editTurns(): TurnSignal[] {
    return this.signals.filter((s) => s.edited === true || isMutatingTool(s.toolName));
  }

  private detect(): Pathology | null {
    if (this.detectExactSpin()) return "exact-spin";
    if (this.detectDiffThrash()) return "diff-thrash";
    if (this.paralysisStreak >= 6) return "read-paralysis";
    if (this.detectMonotonicRegression()) return "monotonic-regression";
    return null;
  }

  private detectExactSpin(): boolean {
    const last = this.signals.slice(-3);
    if (last.length < 3) return false;
    const sig = last[0].errorSignature;
    return !!sig && last.every((s) => s.errorSignature === sig);
  }

  private detectDiffThrash(): boolean {
    const last = this.signals.slice(-3);
    if (last.length < 3) return false;
    const [a, b, c] = last.map((s) => s.diffHash);
    return !!a && !!b && !!c && a === c && a !== b;
  }

  private detectMonotonicRegression(): boolean {
    const edits = this.editTurns().slice(-3);
    if (edits.length < 3) return false;
    const counts = edits.map((s) => s.compilerErrorCount);
    if (counts.some((c) => c === undefined)) return false;
    return (counts[0] as number) < (counts[1] as number) && (counts[1] as number) < (counts[2] as number);
  }
}
