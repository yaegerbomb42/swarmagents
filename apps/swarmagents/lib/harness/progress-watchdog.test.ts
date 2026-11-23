/**
 * Tests for the ProgressWatchdog (Wave 1 Task 4): failure-pathology
 * detection, git checkpoint/restore accuracy, rewind caps, and the
 * FAILED_HYPOTHESES blocks the manager re-drive consumes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProgressWatchdog,
  errorSignature,
  execFileGitRunner,
  normalizeErrorSignature,
  type Checkpoint,
  type TurnSignal,
} from "./progress-watchdog";

const FAIL_A = "FAIL src/foo.test.ts\n  expected 1 to equal 2\n  at Object.<anonymous> (src/foo.test.ts:42:10)";
const FAIL_B = "FAIL src/bar.test.ts\n  timeout after 5000ms";

function signal(partial: Partial<TurnSignal> & { turn: number }): TurnSignal {
  return { ...partial };
}

function spinTurn(turn: number, sig = FAIL_A): TurnSignal {
  return signal({ turn, toolName: "Bash", edited: true, errorSignature: errorSignature(sig) });
}

function readTurn(turn: number, symbols: string[] = []): TurnSignal {
  return signal({ turn, toolName: "Read", readOnly: true, symbolsDiscovered: symbols });
}

/** A real git repo in a temp dir, for checkpoint/restore accuracy. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Watchdog Test"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "original\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

describe("errorSignature", () => {
  it("is stable across timestamps, line numbers and hex addresses", () => {
    const a = "FAIL src/foo.test.ts (12:04:31)\n  at Object.<anonymous> (src/foo.test.ts:42:10) 0x7f3a9c";
    const b = "FAIL src/foo.test.ts (12:09:57)\n  at Object.<anonymous> (src/foo.test.ts:87:3) 0x7f1b2e";
    assert.equal(errorSignature(a), errorSignature(b));
  });

  it("differs for different failures and keeps file paths verbatim", () => {
    assert.notEqual(errorSignature(FAIL_A), errorSignature(FAIL_B));
    assert.match(errorSignature(FAIL_A), /^[0-9a-f]{64}$/); // full SHA-256 hex
  });

  it("normalizes like the ledger expects: volatile parts stripped, paths kept, capped at 240 chars", () => {
    assert.equal(normalizeErrorSignature(FAIL_A), normalizeErrorSignature(FAIL_A.replace("42:10", "99:1")));
    assert.match(normalizeErrorSignature(FAIL_A), /src\/foo\.test\.ts/);
    assert.ok(normalizeErrorSignature("x".repeat(500)).length <= 240);
  });
});

describe("exact-spin detection", () => {
  it("fires on the third consecutive turn with the same error signature", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    assert.equal(wd.observe(spinTurn(1)).pathology, null);
    assert.equal(wd.observe(spinTurn(2)).pathology, null);
    const verdict = wd.observe(spinTurn(3));
    assert.equal(verdict.pathology, "exact-spin");
    assert.equal(verdict.action, "rewind");
    assert.equal(verdict.rewindsUsed, 0);
    assert.equal(verdict.maxRewinds, 2); // surgical default
    assert.match(verdict.failedHypotheses.join(" "), /3\+ times in a row/);
    assert.match(verdict.failedHypotheses.join(" "), /do NOT retry/i);
  });

  it("does not fire for different signatures or after a passing turn", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    wd.observe(spinTurn(1, FAIL_A));
    wd.observe(spinTurn(2, FAIL_B));
    assert.equal(wd.observe(spinTurn(3, FAIL_A)).pathology, null);

    const wd2 = new ProgressWatchdog({ cwd: "/nonexistent" });
    wd2.observe(spinTurn(1));
    wd2.observe(spinTurn(2));
    // A passing turn (no signature) breaks the streak.
    wd2.observe(signal({ turn: 3, toolName: "Bash", edited: true }));
    assert.equal(wd2.observe(spinTurn(4)).pathology, null);
  });

  it("resetAfterRewind clears the streak so the same failure needs 3 fresh turns", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    wd.observe(spinTurn(1));
    wd.observe(spinTurn(2));
    const fired = wd.observe(spinTurn(3));
    assert.equal(fired.pathology, "exact-spin");
    wd.resetAfterRewind();
    assert.equal(wd.observe(spinTurn(4)).pathology, null);
    assert.equal(wd.observe(spinTurn(5)).pathology, null);
    assert.equal(wd.observe(spinTurn(6)).pathology, "exact-spin");
  });
});

describe("diff-thrash detection", () => {
  it("fires when the diff oscillates A -> B -> A", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    const diffTurn = (turn: number, hash: string): TurnSignal =>
      signal({ turn, toolName: "Edit", edited: true, diffHash: hash });
    wd.observe(diffTurn(1, "diff-aaaa"));
    wd.observe(diffTurn(2, "diff-bbbb"));
    const verdict = wd.observe(diffTurn(3, "diff-aaaa"));
    assert.equal(verdict.pathology, "diff-thrash");
    assert.equal(verdict.action, "rewind");
    assert.match(verdict.failedHypotheses.join(" "), /oscillat/i);
  });

  it("does not fire for a steady forward diff or identical diffs", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    const diffTurn = (turn: number, hash: string): TurnSignal =>
      signal({ turn, toolName: "Edit", edited: true, diffHash: hash });
    wd.observe(diffTurn(1, "diff-aaaa"));
    wd.observe(diffTurn(2, "diff-bbbb"));
    assert.equal(wd.observe(diffTurn(3, "diff-cccc")).pathology, null);
    assert.equal(wd.observe(diffTurn(4, "diff-cccc")).pathology, null);
  });
});

describe("read-paralysis detection", () => {
  it("fires on the sixth consecutive read turn that discovers nothing new", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    for (let t = 1; t <= 5; t++) assert.equal(wd.observe(readTurn(t)).pathology, null);
    const verdict = wd.observe(readTurn(6));
    assert.equal(verdict.pathology, "read-paralysis");
    assert.equal(verdict.action, "rewind");
    assert.match(verdict.failedHypotheses.join(" "), /6\+ consecutive read/i);
  });

  it("resets when a read discovers a new symbol or a turn mutates", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    for (let t = 1; t <= 5; t++) wd.observe(readTurn(t));
    wd.observe(readTurn(6, ["src/new.ts"]));
    assert.equal(wd.observe(readTurn(7)).pathology, null);

    const wd2 = new ProgressWatchdog({ cwd: "/nonexistent" });
    for (let t = 1; t <= 5; t++) wd2.observe(readTurn(t));
    wd2.observe(signal({ turn: 6, toolName: "Edit", edited: true }));
    assert.equal(wd2.observe(readTurn(7)).pathology, null);
  });
});

describe("monotonic-regression detection", () => {
  it("fires when compiler errors strictly increase across three edit turns", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    const edit = (turn: number, errors: number): TurnSignal =>
      signal({ turn, toolName: "Edit", edited: true, compilerErrorCount: errors });
    wd.observe(edit(1, 1));
    wd.observe(edit(2, 2));
    const verdict = wd.observe(edit(3, 3));
    assert.equal(verdict.pathology, "monotonic-regression");
    assert.equal(verdict.action, "rewind");
    assert.match(verdict.failedHypotheses.join(" "), /1 -> 2 -> 3/);
  });

  it("does not fire when errors fall, plateau, or are interleaved with reads", () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    const edit = (turn: number, errors: number): TurnSignal =>
      signal({ turn, toolName: "Edit", edited: true, compilerErrorCount: errors });
    wd.observe(edit(1, 1));
    wd.observe(edit(2, 3));
    assert.equal(wd.observe(edit(3, 2)).pathology, null); // fell
    assert.equal(wd.observe(edit(4, 2)).pathology, null); // plateau

    const wd2 = new ProgressWatchdog({ cwd: "/nonexistent" });
    wd2.observe(edit(1, 1));
    wd2.observe(readTurn(2));
    wd2.observe(edit(3, 2));
    wd2.observe(readTurn(4));
    assert.equal(wd2.observe(edit(5, 3)).pathology, "monotonic-regression"); // reads don't break the edit streak
  });
});

describe("bestCheckpoint and rewind caps", () => {
  it("picks the highest pass count, then fewest errors, then newest", async () => {
    const git = {
      async writeTree(): Promise<string> {
        return `tree-${Math.random().toString(16).slice(2)}`;
      },
      async restoreTree(): Promise<void> {},
    };
    const wd2 = new ProgressWatchdog({ cwd: "/tmp", git });
    await wd2.checkpointNow({ turn: 1, testPassCount: 5, compilerErrorCount: 2, diffHash: "" });
    await wd2.checkpointNow({ turn: 2, testPassCount: 9, compilerErrorCount: 1, diffHash: "" });
    await wd2.checkpointNow({ turn: 3, testPassCount: 9, compilerErrorCount: 0, diffHash: "" });
    await wd2.checkpointNow({ turn: 4, testPassCount: 9, compilerErrorCount: 0, diffHash: "" });
    const best = wd2.bestCheckpoint();
    assert.ok(best);
    assert.equal(best.step, 4); // tied on passes/errors with turn 3, newest wins
  });

  it("escalates once the rewind cap is reached (surgical 2, feature 4)", async () => {
    const git = {
      async writeTree(): Promise<string> {
        return "tree-x";
      },
      async restoreTree(): Promise<void> {},
    };
    const wd = new ProgressWatchdog({ cwd: "/tmp", git, mode: "surgical" });
    // A checkpoint must exist for the verdict to carry one.
    const cp = await wd.checkpointNow({ turn: 0, testPassCount: 1, compilerErrorCount: 0, diffHash: "" });
    assert.ok(cp);
    // Drive two rewinds through the public API.
    wd.observe(spinTurn(1));
    wd.observe(spinTurn(2));
    const first = wd.observe(spinTurn(3));
    assert.equal(first.action, "rewind");
    await wd.rewind(first.checkpoint!);
    wd.resetAfterRewind();
    wd.observe(spinTurn(1));
    wd.observe(spinTurn(2));
    const second = wd.observe(spinTurn(3));
    assert.equal(second.action, "rewind");
    await wd.rewind(second.checkpoint!);
    wd.resetAfterRewind();
    wd.observe(spinTurn(1));
    wd.observe(spinTurn(2));
    const third = wd.observe(spinTurn(3));
    assert.equal(third.action, "escalate");
    assert.match(third.failedHypotheses.join(" "), /escalat/i);

    const feature = new ProgressWatchdog({ cwd: "/tmp", git, mode: "feature" });
    assert.equal(feature.observe(spinTurn(1)).maxRewinds, 4);
  });

  it("checkpointNow returns null with no git runner (detection-only mode)", async () => {
    const wd = new ProgressWatchdog({ cwd: "/nonexistent" });
    assert.equal(await wd.checkpointNow({ turn: 1, testPassCount: 0, compilerErrorCount: 0, diffHash: "" }), null);
    assert.equal(wd.bestCheckpoint(), undefined);
    assert.equal(wd.observe(spinTurn(1)).pathology, null); // detection still works
  });
});

describe("maybeCheckpoint policy", () => {
  it("checkpoints the first mutating turn then every Nth, never on reads", async () => {
    let writes = 0;
    const git = {
      async writeTree(): Promise<string> {
        writes++;
        return `tree-${writes}`;
      },
      async restoreTree(): Promise<void> {},
    };
    const wd = new ProgressWatchdog({ cwd: "/tmp", git, checkpointEveryNTurns: 3 });
    const mutating = (turn: number): TurnSignal => signal({ turn, toolName: "Edit", edited: true });
    assert.ok(await wd.maybeCheckpoint(mutating(1)));
    assert.equal(await wd.maybeCheckpoint(mutating(2)), null);
    assert.equal(await wd.maybeCheckpoint(mutating(3)), null);
    assert.ok(await wd.maybeCheckpoint(mutating(4)));
    assert.equal(await wd.maybeCheckpoint(readTurn(5)), null);
    assert.equal(await wd.maybeCheckpoint(readTurn(6)), null);
    assert.ok(await wd.maybeCheckpoint(mutating(7)));
    assert.equal(writes, 3);
  });
});

describe("git checkpoint / restore accuracy (real temp repo)", () => {
  it("restores tracked files, leaves untracked and ignored files alone, and does not touch the real index", async () => {
    const dir = makeTempRepo();
    try {
      const git = execFileGitRunner();
      const wd = new ProgressWatchdog({ cwd: dir, git });
      const cp = await wd.checkpointNow({ turn: 1, testPassCount: 3, compilerErrorCount: 0, diffHash: "" });
      assert.ok(cp);
      assert.match(cp.treeHash, /^[0-9a-f]{40}$/);

      // Stage a change in the REAL index first: checkpointing must not
      // disturb it (throwaway GIT_INDEX_FILE).
      writeFileSync(join(dir, "a.txt"), "staged change\n");
      execFileSync("git", ["add", "a.txt"], { cwd: dir });
      const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      assert.match(statusBefore, /^M\s+a\.txt$/m);
      const cp2 = await wd.checkpointNow({ turn: 2, testPassCount: 3, compilerErrorCount: 0, diffHash: "" });
      assert.ok(cp2);
      const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
      assert.equal(statusAfter, statusBefore);
      // The staged change was captured in the second checkpoint's tree.
      const stagedTree = execFileSync("git", ["show", `${cp2.treeHash}:a.txt`], { cwd: dir, encoding: "utf8" });
      assert.equal(stagedTree, "staged change\n");

      // Now dirty the tree: modify the tracked file, add an untracked file
      // and an ignored file.
      writeFileSync(join(dir, "a.txt"), "broken edit\n");
      writeFileSync(join(dir, "scratch.txt"), "untracked\n");
      writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
      writeFileSync(join(dir, "ignored.log"), "ignored\n");
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "broken edit\n");

      await wd.rewind(cp!);
      // Tracked file restored to the first checkpoint's content.
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "original\n");
      // Untracked and ignored files survive the rewind (read-tree -u only
      // touches tracked paths).
      assert.equal(readFileSync(join(dir, "scratch.txt"), "utf8"), "untracked\n");
      assert.equal(readFileSync(join(dir, "ignored.log"), "utf8"), "ignored\n");
      assert.ok(existsSync(join(dir, ".gitignore")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkpoint latency is small and observe() is far under the 30ms/turn budget", async () => {
    const dir = makeTempRepo();
    try {
      const wd = new ProgressWatchdog({ cwd: dir, git: execFileGitRunner() });
      const t0 = Date.now();
      await wd.checkpointNow({ turn: 1, testPassCount: 0, compilerErrorCount: 0, diffHash: "" });
      const checkpointMs = Date.now() - t0;

      const t1 = Date.now();
      for (let i = 0; i < 1000; i++) {
        wd.observe(spinTurn(i + 2));
      }
      const observeMsPerTurn = (Date.now() - t1) / 1000;
      assert.ok(observeMsPerTurn < 30, `observe() averaged ${observeMsPerTurn}ms/turn`);
      // Checkpointing is a couple of git spawns; it runs on the gate chain
      // (not the stream path) and must stay well under a second.
      assert.ok(checkpointMs < 1000, `checkpoint took ${checkpointMs}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
