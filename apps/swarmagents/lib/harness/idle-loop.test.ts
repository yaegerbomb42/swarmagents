/**
 * Unit tests for the always-on A1 idle loop (lib/harness/idle-loop.ts).
 *
 * The acceptance criteria this locks in (propose-only MVP, James's redesign):
 *   - the loop is OFF unless SWARM_A1_IDLE_LOOP=1, and a board pause task
 *     ([a1-loop-pause]) pauses it;
 *   - the denylist is enforced: billing/deploy/secrets/auth/user-data/
 *     destructive proposals are rejected, never executed;
 *   - the token budget per iteration is capped at the hard cap;
 *   - the proposal call uses the router's fast tier (never a hard-coded
 *     paid model) and respects preferFreeProviders;
 *   - two iterations never run concurrently, across ticks too (one loop
 *     object per user at module level);
 *   - a hard daily cap (default 2) bounds loop outputs per user per day,
 *     persisted so a restart does not reset it; a failed or refused
 *     dispatch latches the loop off for the rest of the day;
 *   - idleness is scoped to the user's own runs — other people's open
 *     board tasks never block the loop;
 *   - the loop dedupes against its own user's open proposals (per-user
 *     marker), so two always-on users never duplicate each other;
 *   - by default the loop only proposes (creates a board task and stops);
 *     dispatch needs SWARM_A1_IDLE_LOOP_DISPATCH=1 and goes through the
 *     normal approval gateway (fullAuto: false);
 *   - the kill-switch stops the loop within one iteration (flipping the
 *     flag mid-iteration creates no task and dispatches nothing).
 * No real LLM calls happen in these tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  A1_IDLE_LOOP_PAUSE_MARKER,
  DEFAULT_DAILY_CAP,
  DEFAULT_MAX_TOKENS_PER_ITERATION,
  HARD_CAP_TOKENS_PER_ITERATION,
  MAX_DIGEST_CHARS,
  buildIdleLoopLlmOptions,
  buildIdleLoopPrompt,
  buildRepoDigest,
  createFileBudgetStore,
  createIdleLoop,
  createMemoryBudgetStore,
  extractCompletionText,
  idleLoopCountForTesting,
  idleLoopUserMarker,
  isDispatchEnabled,
  isIdleLoopEnabled,
  isIdleLoopPaused,
  isUserIdle,
  parseProposalResponse,
  resolveDailyCap,
  resolveTokenBudget,
  runIdleIteration,
  stopIdleLoopTicksForTesting,
  tickIdleLoops,
  validateProposal,
} from "./idle-loop";
import type { CreativeProposal, IdleLoopDeps, IdleLoopEvent } from "./idle-loop";

function validProposal(overrides: Partial<CreativeProposal> = {}): CreativeProposal {
  return {
    title: "Polish the empty workspace state",
    description: "Add a friendlier empty state with a sample task button.",
    area: "ui",
    files: ["apps/swarmagents/components/EmptyState.tsx"],
    ...overrides,
  };
}

function mockDeps(overrides: Partial<IdleLoopDeps> = {}): {
  deps: IdleLoopDeps;
  calls: string[];
  events: IdleLoopEvent[];
  env: Record<string, string>;
} {
  const calls: string[] = [];
  const events: IdleLoopEvent[] = [];
  const env: Record<string, string> = { SWARM_A1_IDLE_LOOP: "1" };
  const deps: IdleLoopDeps = {
    userId: "user-1",
    env,
    isIdle: async () => true,
    gatherDigest: async () => ({
      openTasks: [{ id: "t1", title: "Fix the flaky watchdog test" }],
      recentCommits: ["abc1234 fix gateway body bypass"],
    }),
    listOpenTasks: async () => [],
    llmCall: async () => ({
      text: JSON.stringify(validProposal()),
      tokensUsed: 120,
    }),
    createBoardTask: async () => {
      calls.push("create");
      return { id: "task_new" };
    },
    implementTask: async () => {
      calls.push("implement");
      return { branch: "feat/idle-polish", prUrl: "https://github.com/x/y/pull/1" };
    },
    budget: createMemoryBudgetStore(),
    emit: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  return { deps, calls, events, env };
}

test("kill-switch: the loop is off unless SWARM_A1_IDLE_LOOP is exactly 1", () => {
  assert.equal(isIdleLoopEnabled({}), false);
  assert.equal(isIdleLoopEnabled({ SWARM_A1_IDLE_LOOP: "0" }), false);
  assert.equal(isIdleLoopEnabled({ SWARM_A1_IDLE_LOOP: "yes" }), false);
  assert.equal(isIdleLoopEnabled({ SWARM_A1_IDLE_LOOP: "1" }), true);
});

test("pause signal: an open [a1-loop-pause] task pauses the loop", () => {
  assert.equal(isIdleLoopPaused([]), false);
  assert.equal(isIdleLoopPaused([{ title: "Fix login" }]), false);
  assert.equal(
    isIdleLoopPaused([{ title: `${A1_IDLE_LOOP_PAUSE_MARKER} stop the loop for now` }]),
    true,
  );
});

test("token budget: requests clamp to the hard cap", () => {
  assert.equal(resolveTokenBudget(undefined), DEFAULT_MAX_TOKENS_PER_ITERATION);
  assert.equal(resolveTokenBudget(100), 100);
  assert.equal(resolveTokenBudget(99999), HARD_CAP_TOKENS_PER_ITERATION);
  assert.equal(resolveTokenBudget(0), 1);
});

test("validateProposal: a well-formed UI proposal passes", () => {
  const result = validateProposal(validProposal());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.proposal.area, "ui");
});

test("validateProposal: disallowed areas are rejected", () => {
  assert.equal(validateProposal(validProposal({ area: "billing" as never })).ok, false);
  assert.equal(validateProposal(validProposal({ area: "deploy" as never })).ok, false);
});

test("validateProposal: forbidden topics are rejected, never executed", () => {
  const forbidden: Array<Partial<CreativeProposal>> = [
    { title: "Add a billing page", description: "Show invoices." },
    { title: "Deploy the new build", description: "Ship it." },
    { title: "Rotate secrets", description: "Rotate the api key." },
    { title: "Fix password reset", description: "Passwords are broken." },
    { title: "Fix auth token refresh", description: "Tokens expire too fast." },
    { title: "Export user data", description: "Let users download personal data." },
    { title: "Delete dead code", description: "Remove unused modules." },
    { title: "Drop the old table", description: "drop table users." },
  ];
  for (const proposal of forbidden) {
    const result = validateProposal(validProposal(proposal));
    assert.equal(result.ok, false, JSON.stringify(proposal));
  }
});

test("validateProposal: no false positives on innocent words", () => {
  // "author" contains "auth" but must not trip the auth denylist.
  assert.equal(
    validateProposal(validProposal({ title: "Author bio page", description: "Show the author." }))
      .ok,
    true,
  );
  assert.equal(
    validateProposal(
      validProposal({ title: "Reduce token usage", description: "Trim gateway token spend." }),
    ).ok,
    true,
  );
});

test("validateProposal: shape and file scope are enforced", () => {
  assert.equal(validateProposal(null).ok, false);
  assert.equal(validateProposal(validProposal({ title: "  " })).ok, false);
  assert.equal(validateProposal(validProposal({ description: "" })).ok, false);
  assert.equal(
    validateProposal(validProposal({ title: "x".repeat(201) })).ok,
    false,
  );
  assert.equal(
    validateProposal(validProposal({ files: ["/etc/passwd"] })).ok,
    false,
  );
  assert.equal(
    validateProposal(validProposal({ files: ["apps/swarmagents/../../secrets.txt"] })).ok,
    false,
  );
  assert.equal(
    validateProposal(validProposal({ files: ["docs/architecture/plan.md"] })).ok,
    true,
  );
});

test("buildRepoDigest: bounded in items and total chars", () => {
  const digest = buildRepoDigest({
    openTasks: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, title: `Task number ${i} ` + "x".repeat(200) })),
    recentCommits: Array.from({ length: 30 }, (_, i) => `commit ${i} ` + "y".repeat(200)),
    knownGaps: ["gap"],
  });
  assert.ok(digest.length <= MAX_DIGEST_CHARS, `digest is ${digest.length} chars`);
  assert.equal((digest.match(/Task number \d+/g) ?? []).length, 10);
});

test("buildIdleLoopPrompt: grounds the proposal in the digest", () => {
  const prompt = buildIdleLoopPrompt("Open board tasks (1):\n- Fix login");
  assert.match(prompt, /Fix login/);
  assert.match(prompt, /JSON only/);
});

test("parseProposalResponse: accepts JSON, tolerates surrounding prose", () => {
  const bare = parseProposalResponse(JSON.stringify(validProposal()));
  assert.equal(bare.ok, true);
  const wrapped = parseProposalResponse(
    `Here is my idea:\n${JSON.stringify(validProposal())}\nHope that helps.`,
  );
  assert.equal(wrapped.ok, true);
});

test("parseProposalResponse: malformed or forbidden replies are rejected", () => {
  assert.equal(parseProposalResponse("not json at all").ok, false);
  assert.equal(parseProposalResponse("{not valid json").ok, false);
  assert.equal(
    parseProposalResponse(
      JSON.stringify(validProposal({ title: "Deploy now", description: "Ship it." })),
    ).ok,
    false,
  );
});

test("extractCompletionText: Anthropic, OpenAI, and string bodies", () => {
  assert.equal(
    extractCompletionText({ content: [{ type: "text", text: "hello" }] }),
    "hello",
  );
  assert.equal(
    extractCompletionText({ choices: [{ message: { content: "hi" } }] }),
    "hi",
  );
  assert.equal(extractCompletionText("raw"), "raw");
  assert.equal(extractCompletionText({ nope: true }), "");
});

test("runIdleIteration: propose-only by default — propose, create, stop (no dispatch)", async () => {
  const { deps, calls, events } = mockDeps();
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "proposed");
  assert.equal(result.taskId, "task_new");
  assert.equal(result.prUrl, undefined);
  assert.deepEqual(calls, ["create"]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["idle-loop.proposed"],
  );
  assert.equal(events[0].proposal?.title, "Polish the empty workspace state");
});

test("runIdleIteration: with SWARM_A1_IDLE_LOOP_DISPATCH=1 — propose, create, dispatch, PR", async () => {
  const { deps, calls, events } = mockDeps({
    env: { SWARM_A1_IDLE_LOOP: "1", SWARM_A1_IDLE_LOOP_DISPATCH: "1" },
  });
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "done");
  assert.equal(result.taskId, "task_new");
  assert.equal(result.prUrl, "https://github.com/x/y/pull/1");
  assert.equal(result.branch, "feat/idle-polish");
  assert.deepEqual(calls, ["create", "implement"]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["idle-loop.proposed", "idle-loop.pr"],
  );
});

test("runIdleIteration: not idle means no LLM call and no work", async () => {
  let llmCalls = 0;
  const { deps, calls } = mockDeps({
    isIdle: async () => false,
    llmCall: async () => {
      llmCalls += 1;
      return { text: "{}" };
    },
  });
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "not-idle");
  assert.equal(llmCalls, 0);
  assert.deepEqual(calls, []);
});

test("runIdleIteration: disabled loop and pause marker short-circuit", async () => {
  const disabled = mockDeps({ env: {} });
  assert.equal((await runIdleIteration(disabled.deps)).status, "disabled");
  const paused = mockDeps({
    listOpenTasks: async () => [{ id: "p1", title: `${A1_IDLE_LOOP_PAUSE_MARKER} hold` }],
  });
  assert.equal((await runIdleIteration(paused.deps)).status, "paused");
});

test("runIdleIteration: a denylisted proposal is rejected and never executed", async () => {
  const { deps, calls, events } = mockDeps({
    llmCall: async () => ({
      text: JSON.stringify(
        validProposal({ title: "Add billing page", description: "Show invoices.", area: "ui" }),
      ),
      tokensUsed: 90,
    }),
  });
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "rejected");
  assert.deepEqual(calls, []);
  assert.equal(events[0]?.type, "idle-loop.rejected");
});

test("runIdleIteration: the kill-switch stops it within one iteration", async () => {
  const { deps, calls, env } = mockDeps({
    llmCall: async () => {
      // The owner kills the loop while the proposal is in flight.
      env.SWARM_A1_IDLE_LOOP = "0";
      return { text: JSON.stringify(validProposal()), tokensUsed: 120 };
    },
  });
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "stopped");
  // The kill-switch is re-checked BEFORE the board task is created, so a
  // loop killed mid-iteration creates nothing and dispatches nothing.
  assert.deepEqual(calls, []);
  assert.equal(result.taskId, undefined);
});

test("runIdleIteration: the per-iteration token budget is capped", async () => {
  let seenMaxTokens = 0;
  const { deps } = mockDeps({
    maxTokensPerIteration: 99999,
    llmCall: async (_prompt, { maxTokens }) => {
      seenMaxTokens = maxTokens;
      return { text: JSON.stringify(validProposal()) };
    },
  });
  await runIdleIteration(deps);
  assert.equal(seenMaxTokens, HARD_CAP_TOKENS_PER_ITERATION);
});

test("createIdleLoop: two iterations never run concurrently", async () => {
  const { deps } = mockDeps({
    // Slow proposal call, so the first iteration is genuinely in flight
    // when the second runOnce lands.
    llmCall: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { text: JSON.stringify(validProposal()), tokensUsed: 120 };
    },
  });
  const loop = createIdleLoop(deps);
  const [first, second] = await Promise.all([loop.runOnce(), loop.runOnce()]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, ["already-running", "proposed"]);
});

test("createIdleLoop: start/stop with injected timers", () => {
  const { deps } = mockDeps();
  const scheduled = new Map<number, () => void>();
  let nextId = 0;
  let cleared: number[] = [];
  const loop = createIdleLoop(deps, {
    setInterval: ((fn: () => void) => {
      const id = ++nextId;
      scheduled.set(id, fn);
      return id as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearInterval: ((id: unknown) => {
      cleared.push(id as number);
      scheduled.delete(id as number);
    }) as typeof clearInterval,
  });
  loop.start(1000);
  assert.equal(scheduled.size, 1);
  loop.start(1000); // idempotent: no second timer
  assert.equal(scheduled.size, 1);
  loop.stop();
  assert.deepEqual(cleared, [1]);
  assert.equal(scheduled.size, 0);
});

test("resolveDailyCap and isDispatchEnabled: defaults and overrides", () => {
  assert.equal(resolveDailyCap({}), DEFAULT_DAILY_CAP);
  assert.equal(resolveDailyCap({ SWARM_A1_IDLE_LOOP_DAILY_CAP: "1" }), 1);
  assert.equal(resolveDailyCap({ SWARM_A1_IDLE_LOOP_DAILY_CAP: "0" }), 0);
  assert.equal(resolveDailyCap({ SWARM_A1_IDLE_LOOP_DAILY_CAP: "999" }), 10);
  assert.equal(resolveDailyCap({ SWARM_A1_IDLE_LOOP_DAILY_CAP: "nope" }), DEFAULT_DAILY_CAP);
  assert.equal(isDispatchEnabled({}), false);
  assert.equal(isDispatchEnabled({ SWARM_A1_IDLE_LOOP_DISPATCH: "0" }), false);
  assert.equal(isDispatchEnabled({ SWARM_A1_IDLE_LOOP_DISPATCH: "1" }), true);
});

test("buildIdleLoopLlmOptions: router fast tier, no hard-coded model", () => {
  const opts = buildIdleLoopLlmOptions("user-1", "propose something", 2000);
  assert.equal(opts.owner, "user-1");
  assert.equal(opts.requestedModel, "fast");
  assert.equal(opts.useRoutedModel, true);
  assert.equal(opts.runId, "idle-loop-user-1");
  assert.deepEqual(opts.body, {
    messages: [{ role: "user", content: "propose something" }],
    max_tokens: 2000,
    stream: false,
  });
  // No model id anywhere in the request: the router chooses the model.
  assert.equal(JSON.stringify(opts).includes("claude-sonnet"), false);
  assert.equal("model" in opts.body, false);
});

test("isUserIdle: scoped to the user's own runs, never the board", () => {
  const idleRuntime = {
    list: () => [{ status: "finished" }, { status: "cancelled" }],
    vmManager: { hasActiveExec: () => false },
  };
  assert.equal(isUserIdle(idleRuntime, "user-1"), true);
  assert.equal(
    isUserIdle(
      { list: () => [{ status: "queued" }], vmManager: { hasActiveExec: () => false } },
      "user-1",
    ),
    false,
  );
  assert.equal(
    isUserIdle(
      { list: () => [{ status: "running" }], vmManager: { hasActiveExec: () => false } },
      "user-1",
    ),
    false,
  );
  assert.equal(
    isUserIdle(
      { list: () => [], vmManager: { hasActiveExec: () => true } },
      "user-1",
    ),
    false,
  );
  // A throwing runtime is treated as not idle (fail closed).
  assert.equal(
    isUserIdle(
      {
        list: () => {
          throw new Error("boom");
        },
        vmManager: { hasActiveExec: () => false },
      },
      "user-1",
    ),
    false,
  );
});

test("runIdleIteration: other people's open tasks never block the loop", async () => {
  const { deps } = mockDeps({
    // The board always has dozens of open tasks; none of them are this user's.
    listOpenTasks: async () =>
      Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `Somebody else's task ${i}` })),
  });
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "proposed");
});

test("runIdleIteration: an open proposal of this user's loop is not duplicated", async () => {
  let llmCalls = 0;
  const { deps, calls } = mockDeps({
    llmCall: async () => {
      llmCalls += 1;
      return { text: JSON.stringify(validProposal()), tokensUsed: 120 };
    },
    listOpenTasks: async () => [
      {
        id: "t1",
        title: "Polish the empty workspace state",
        description: `Already proposed ${idleLoopUserMarker("user-1")} (area: ui).`,
      },
    ],
  });
  const result = await runIdleIteration(deps);
  assert.equal(result.status, "duplicate");
  assert.deepEqual(calls, []);
  assert.equal(llmCalls, 1);
  // Same title, but another user's loop: not a duplicate.
  const other = mockDeps({
    listOpenTasks: async () => [
      {
        id: "t1",
        title: "Polish the empty workspace state",
        description: `Already proposed ${idleLoopUserMarker("user-2")} (area: ui).`,
      },
    ],
  });
  assert.equal((await runIdleIteration(other.deps)).status, "proposed");
});

test("runIdleIteration: the daily cap stops the loop without spending LLM tokens", async () => {
  let llmCalls = 0;
  const { deps } = mockDeps({
    env: { SWARM_A1_IDLE_LOOP: "1", SWARM_A1_IDLE_LOOP_DAILY_CAP: "1" },
    llmCall: async () => {
      llmCalls += 1;
      return { text: JSON.stringify(validProposal()), tokensUsed: 120 };
    },
  });
  assert.equal((await runIdleIteration(deps)).status, "proposed");
  assert.equal((await runIdleIteration(deps)).status, "capped");
  assert.equal(llmCalls, 1);
  // Cap 0 means the loop never proposes.
  const zero = mockDeps({
    env: { SWARM_A1_IDLE_LOOP: "1", SWARM_A1_IDLE_LOOP_DAILY_CAP: "0" },
    llmCall: async () => {
      llmCalls += 1;
      return { text: JSON.stringify(validProposal()) };
    },
  });
  assert.equal((await runIdleIteration(zero.deps)).status, "capped");
  assert.equal(llmCalls, 1);
});

test("runIdleIteration: a failed dispatch latches the loop off for the day", async () => {
  let llmCalls = 0;
  const { deps, calls } = mockDeps({
    env: { SWARM_A1_IDLE_LOOP: "1", SWARM_A1_IDLE_LOOP_DISPATCH: "1" },
    llmCall: async () => {
      llmCalls += 1;
      return { text: JSON.stringify(validProposal()), tokensUsed: 120 };
    },
    implementTask: async () => {
      calls.push("implement");
      throw new Error("run refused");
    },
  });
  const first = await runIdleIteration(deps);
  assert.equal(first.status, "stopped");
  assert.match(first.reason ?? "", /dispatch failed/);
  assert.deepEqual(calls, ["create", "implement"]);
  // The next tick the same day does not retry (and spends no LLM tokens).
  const second = await runIdleIteration(deps);
  assert.equal(second.status, "stopped");
  assert.equal(llmCalls, 1);
});

test("tickIdleLoops: overlapping ticks for one user share one loop", async () => {
  try {
    const { deps } = mockDeps({
      userId: "tick-user-a",
      llmCall: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { text: JSON.stringify(validProposal()), tokensUsed: 120 };
      },
    });
    const factory = () => deps;
    const [first, second] = await Promise.all([
      tickIdleLoops(factory, ["tick-user-a"]),
      tickIdleLoops(factory, ["tick-user-a"]),
    ]);
    const statuses = [first[0].status, second[0].status].sort();
    assert.deepEqual(statuses, ["already-running", "proposed"]);
    assert.equal(idleLoopCountForTesting(), 1);
  } finally {
    stopIdleLoopTicksForTesting();
  }
});

test("tickIdleLoops: two users get two loops; a user leaving drops theirs", async () => {
  try {
    const a = mockDeps({ userId: "tick-user-a" });
    const b = mockDeps({ userId: "tick-user-b" });
    const factory = (userId: string) => (userId === "tick-user-a" ? a.deps : b.deps);
    const both = await tickIdleLoops(factory, ["tick-user-a", "tick-user-b"]);
    assert.deepEqual(
      both.map((r) => r.status),
      ["proposed", "proposed"],
    );
    assert.equal(idleLoopCountForTesting(), 2);
    await tickIdleLoops(factory, ["tick-user-b"]);
    assert.equal(idleLoopCountForTesting(), 1);
  } finally {
    stopIdleLoopTicksForTesting();
  }
});

test("createMemoryBudgetStore: a new day resets the count and the latch", () => {
  let day = "2026-11-26";
  const store = createMemoryBudgetStore(() => day);
  store.recordAction("user-1");
  store.recordFailure("user-1");
  assert.deepEqual(store.load("user-1"), { date: "2026-11-26", actions: 1, failed: true });
  day = "2026-11-27";
  assert.deepEqual(store.load("user-1"), { date: "2026-11-27", actions: 0, failed: false });
});

test("createFileBudgetStore: round-trips, survives corruption, rolls over", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "idle-loop-budget-"));
  try {
    const filePath = path.join(dir, "budget.json");
    const store = createFileBudgetStore({ filePath });
    store.recordAction("user-1");
    store.recordAction("user-1");
    store.recordFailure("user-2");
    // A new instance on the same file sees the persisted state.
    const reopened = createFileBudgetStore({ filePath });
    assert.equal(reopened.load("user-1").actions, 2);
    assert.equal(reopened.load("user-2").failed, true);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8"))["user-1"].actions, 2);
    // A corrupt file behaves as an empty store.
    writeFileSync(filePath, "not json", "utf8");
    assert.deepEqual(createFileBudgetStore({ filePath }).load("user-1"), {
      date: new Date().toISOString().slice(0, 10),
      actions: 0,
      failed: false,
    });
    // A new day resets.
    const dayStore = createFileBudgetStore({ filePath, today: () => "2026-11-26" });
    dayStore.recordAction("user-1");
    const nextDay = createFileBudgetStore({ filePath, today: () => "2026-11-27" });
    assert.equal(nextDay.load("user-1").actions, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
