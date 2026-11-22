/**
 * Tests for the prefix-stable prompt builder
 * (lib/providers/cache-aware-prompt.ts).
 *
 * Locks in the 4-zone layout, Zone 0 validation, the prefix hash audit
 * (including the CACHE_BUST_WARNING byte-diff), the 15-turn simulation
 * from the exit criteria, and the per-run cache metrics.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CacheAwarePromptBuilder,
  byteDiff,
  sha256Hex,
  validateZone0,
} from "./cache-aware-prompt";

const ZONE0 = [
  "You are a senior engineer working in the repo.",
  "Step 1: read the files in scope before editing anything.",
  "Step 2: make deterministic edits as unified diffs.",
  "Primitive tools: read_file, write_file, run_tests.",
].join("\n");
const ZONE1 = ["## Repo skeleton", "src/upload/retry.ts: retryWithBackoff()", "## SPEC.md", "Fix the flaky upload."].join(
  "\n",
);

test("validateZone0 rejects volatile content, allows static numbered instructions", () => {
  validateZone0(ZONE0);
  assert.throws(() => validateZone0(`${ZONE0}\nBuilt at 2026-11-22T10:15:30Z`), /timestamp/);
  assert.throws(() => validateZone0(`${ZONE0}\nTime is 10:15:30`), /clock time/);
  assert.throws(() => validateZone0(`${ZONE0}\nRun id: run_abc123`), /run id/);
  assert.throws(() => validateZone0(`${ZONE0}\nsession_id=abc123`), /session id/);
  assert.throws(() => validateZone0(`${ZONE0}\nref 550e8400-e29b-41d4-a716-446655440000`), /UUID/);
  assert.throws(() => validateZone0(`${ZONE0}\nCurrent step 3 of the plan`), /live step\/turn counter/);
  assert.throws(() => validateZone0(`${ZONE0}\nWe are on step 4 of 10`), /step counter/);
});

test("sha256Hex and byteDiff pinpoint the first differing byte", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abc"), sha256Hex("abc"));
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
  const diff = byteDiff("hello world, this is zone zero", "hello world, this is zone ONE");
  assert.ok(diff.firstDiffByte > 0);
  assert.match(diff.previousExcerpt, /zone zero/);
  assert.match(diff.currentExcerpt, /zone ONE/);
  assert.equal(byteDiff("same", "same").firstDiffByte, 4);
});

test("build lays out the four zones in order with all three breakpoints", () => {
  const builder = new CacheAwarePromptBuilder({ zone0: ZONE0, zone1: ZONE1 });
  const built = builder.build({
    trajectory: [
      { role: "user", content: "turn 1: fix the retry" },
      { role: "assistant", content: "edited retry.ts" },
    ],
    zone3: "Budget: 1200/8192 tokens. Diff: retry.ts +12/-3.",
  });
  assert.equal(built.request.system, ZONE0);
  assert.deepEqual(
    built.request.messages.map((m) => m.content),
    [ZONE1, "turn 1: fix the retry", "edited retry.ts", "Budget: 1200/8192 tokens. Diff: retry.ts +12/-3."],
  );
  assert.deepEqual(built.request.cacheBreakpoints, {
    system: true,
    firstMessage: true,
    secondLastMessage: true,
  });
  assert.equal(built.zoneHashes.zone0, sha256Hex(ZONE0));
  assert.equal(built.zoneHashes.zone1, sha256Hex(ZONE1));
  assert.deepEqual(built.warnings, []);
});

test("build omits empty zones and skips breakpoints that would land on Zone 1", () => {
  const builder = new CacheAwarePromptBuilder({ zone0: ZONE0, zone1: "" });
  const built = builder.build({
    trajectory: [{ role: "user", content: "only turn" }],
    zone3: "",
  });
  assert.equal(built.request.messages.length, 1);
  assert.deepEqual(built.request.cacheBreakpoints, { system: true });
});

test("simulation: 15 turns with dynamic budget updates keep Zone 0 identical; Zone 1 changes only on skill mount", () => {
  const builder = new CacheAwarePromptBuilder({ zone0: ZONE0, zone1: ZONE1 });
  const trajectory: { role: "user" | "assistant"; content: string }[] = [];
  const zone0Hashes = new Set<string>();
  const zone1Hashes: string[] = [];
  let warnings = 0;
  for (let turn = 1; turn <= 15; turn++) {
    trajectory.push({ role: "user", content: `turn ${turn}: continue the fix` });
    trajectory.push({ role: "assistant", content: `turn ${turn}: edited code` });
    if (turn === 8) builder.mountSkill("## SKILL.md: upload-retries\nRetry with exponential backoff, max 3 attempts.");
    const built = builder.build({
      trajectory: [...trajectory],
      zone3: `Budget: turn ${turn} used ${100 * turn} tokens. Diff: ${turn} files changed.`,
    });
    zone0Hashes.add(built.zoneHashes.zone0);
    zone1Hashes.push(built.zoneHashes.zone1);
    warnings += built.warnings.length;
    // The volatile tail changes every turn but never disturbs the prefix.
    assert.equal(built.request.messages[0].content, turn < 8 ? ZONE1 : `${ZONE1}\n\n## SKILL.md: upload-retries\nRetry with exponential backoff, max 3 attempts.`);
  }
  assert.equal(zone0Hashes.size, 1, "Zone 0 hash is 100% identical across all 15 turns");
  assert.equal(warnings, 0);
  const beforeMount = new Set(zone1Hashes.slice(0, 7));
  const afterMount = new Set(zone1Hashes.slice(7));
  assert.equal(beforeMount.size, 1, "Zone 1 is stable before the skill mount");
  assert.equal(afterMount.size, 1, "Zone 1 is stable after the skill mount");
  assert.notEqual(zone1Hashes[6], zone1Hashes[7], "Zone 1 changes only when the skill mounts");
});

test("a mid-session Zone 0 mutation produces a CACHE_BUST_WARNING with the byte-diff", () => {
  const builder = new CacheAwarePromptBuilder({ zone0: ZONE0, zone1: ZONE1 });
  builder.build({ trajectory: [], zone3: "" });
  const mutated = ZONE0.replace("senior engineer", "staff engineer");
  const built = builder.build({ trajectory: [], zone3: "", zone0: mutated });
  assert.equal(built.warnings.length, 1);
  const warning = built.warnings[0];
  assert.equal(warning.type, "CACHE_BUST_WARNING");
  assert.equal(warning.zone, 0);
  assert.equal(warning.previousHash, sha256Hex(ZONE0));
  assert.equal(warning.currentHash, sha256Hex(mutated));
  assert.ok(warning.firstDiffByte > 0);
  assert.match(warning.previousExcerpt, /senior engineer/);
  assert.match(warning.currentExcerpt, /staff engineer/);
});

test("handoff replaces Zone 1; mountSkill appends to it", () => {
  const builder = new CacheAwarePromptBuilder({ zone0: ZONE0, zone1: ZONE1 });
  const first = builder.build({ trajectory: [], zone3: "" });
  builder.mountSkill("## SKILL.md: extra");
  const second = builder.build({ trajectory: [], zone3: "" });
  assert.notEqual(second.zoneHashes.zone1, first.zoneHashes.zone1);
  assert.match(second.request.messages[0].content as string, /SKILL\.md: extra/);
  builder.handoff("## SPEC.md v2: new goal.");
  const third = builder.build({ trajectory: [], zone3: "" });
  assert.equal(third.zoneHashes.zone1, sha256Hex("## SPEC.md v2: new goal."));
  assert.equal(third.request.messages[0].content, "## SPEC.md v2: new goal.");
});

test("recordUsage accumulates per-run cache metrics with an effective hit rate", () => {
  const builder = new CacheAwarePromptBuilder({ zone0: ZONE0, zone1: ZONE1 });
  assert.equal(builder.getCacheMetrics().effectiveCacheHitRate, 0);
  builder.recordUsage({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800 });
  builder.recordUsage({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 900, cacheWriteTokens: 50 });
  builder.recordUsage({ inputTokens: 500, outputTokens: 50 });
  const metrics = builder.getCacheMetrics();
  assert.equal(metrics.calls, 3);
  assert.equal(metrics.cachedInputTokens, 1700);
  assert.equal(metrics.uncachedInputTokens, 800);
  assert.equal(metrics.cacheWriteTokens, 50);
  assert.equal(metrics.effectiveCacheHitRate, 1700 / 2500);
});
