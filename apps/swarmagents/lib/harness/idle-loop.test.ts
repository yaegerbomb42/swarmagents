/**
 * Unit tests for the always-on A1 idle loop (lib/harness/idle-loop.ts).
 *
 * The acceptance criteria this locks in:
 *   - the loop is OFF unless SWARM_A1_IDLE_LOOP=1, and a board pause task
 *     ([a1-loop-pause]) pauses it;
 *   - the denylist is enforced: billing/deploy/secrets/auth/user-data/
 *     destructive proposals are rejected, never executed;
 *   - the token budget per iteration is capped at the hard cap;
 *   - two iterations never run concurrently;
 *   - the kill-switch stops the loop within one iteration (flipping the
 *     flag mid-iteration prevents any implementation dispatch);
 *   - with a mocked LLM, an idle agent proposes a task, creates it, and
 *     dispatches implementation end to end, with telemetry for each step.
 * No real LLM calls happen in these tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  A1_IDLE_LOOP_PAUSE_MARKER,
  DEFAULT_MAX_TOKENS_PER_ITERATION,
  HARD_CAP_TOKENS_PER_ITERATION,
  MAX_DIGEST_CHARS,
  buildIdleLoopPrompt,
  buildRepoDigest,
  createIdleLoop,
  extractCompletionText,
  isIdleLoopEnabled,
  isIdleLoopPaused,
  parseProposalResponse,
  resolveTokenBudget,
  runIdleIteration,
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

test("runIdleIteration: mocked LLM end to end — propose, create, implement, PR", async () => {
  const { deps, calls, events } = mockDeps();
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
  assert.equal(events[0].proposal?.title, "Polish the empty workspace state");
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
  // The task was created, but no implementation was dispatched.
  assert.deepEqual(calls, ["create"]);
  assert.equal(result.taskId, "task_new");
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
    implementTask: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { branch: "feat/x", prUrl: "https://github.com/x/y/pull/2" };
    },
  });
  const loop = createIdleLoop(deps);
  const [first, second] = await Promise.all([loop.runOnce(), loop.runOnce()]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, ["already-running", "done"]);
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
