// Team Mode — fake-harness tests.
//
// The real pipeline (planner → parallel lanes → reviewer → merge) runs with no
// VM, no model and no network: a fake harness implements the same contract
// VmTeamHarness does.

import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamManager } from "./manager";
import { TelemetryBus } from "../telemetry/bus";
import type { VmManager } from "../vm/manager";
import type { TeamHarness, LaneSpec, PlanReviewSpec, PlanSpec, ReviewSpec, MergeSpec } from "./harness";
import type { LaneResult, PlanDraft, TeamTask } from "./types";

interface FakeOptions {
  tasks?: number;
  holdMs?: number;
  rejectFirst?: string;
  tokensPerLane?: number;
  blockLane?: string;
  /** Reject the first N plan-review rounds; 0 (default) approves at once. */
  rejectPlanRounds?: number;
}

class FakeHarness implements TeamHarness {
  readonly id = "fake";
  active = 0;
  maxActive = 0;
  attempts = new Map<string, number>();
  reviews: { taskId: string; attempt: number; approved: boolean }[] = [];
  planReviews: { attempt: number; approved: boolean; note: string }[] = [];
  /** Specs as the manager handed them over, for policy-forwarding assertions. */
  readonly planSpecs: PlanSpec[] = [];
  readonly planReviewSpecs: PlanReviewSpec[] = [];
  readonly laneSpecs: LaneSpec[] = [];
  readonly opts: FakeOptions;
  private releaseWait: (() => void) | null = null;

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  async plan(spec: PlanSpec): Promise<PlanDraft[]> {
    this.planSpecs.push(spec);
    const roles = ["implementer", "backend-engineer", "researcher", "test-writer"];
    const count = this.opts.tasks ?? 3;
    return Array.from({ length: count }, (_, index) => ({
      title: `Task ${String.fromCharCode(65 + index)}${spec.revisionNote ? " (revised)" : ""}`,
      detail: `do ${String.fromCharCode(97 + index)}`,
      roleId: roles[index % roles.length],
    }));
  }

  async reviewPlan(spec: PlanReviewSpec) {
    this.planReviewSpecs.push(spec);
    const approved = spec.attempt > (this.opts.rejectPlanRounds ?? 0);
    const note = approved ? "plan covers the goal" : "task B is too vague — split it";
    this.planReviews.push({ attempt: spec.attempt, approved, note });
    return { approved, note, tokens: 1, costUsd: 0 };
  }

  async lane(spec: LaneSpec): Promise<LaneResult> {
    this.laneSpecs.push(spec);
    this.attempts.set(spec.agentId, (this.attempts.get(spec.agentId) ?? 0) + 1);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.opts.blockLane === spec.agentId) {
        await new Promise<void>((resolve) => {
          this.releaseWait = resolve;
        });
      } else if (this.opts.holdMs) {
        await new Promise((resolve) => setTimeout(resolve, this.opts.holdMs));
      }
    } finally {
      this.active -= 1;
    }
    return {
      ok: true,
      summary: `${spec.agentId} complete`,
      files: [`${spec.agentId}.md`],
      tokens: this.opts.tokensPerLane ?? 5,
      costUsd: 0.0001,
      provider: "fake",
      model: "fake-model",
    };
  }

  release(): void {
    this.releaseWait?.();
    this.releaseWait = null;
  }

  async review(spec: ReviewSpec) {
    const approved = !(spec.task.id === "t2" && spec.attempt === 1 && this.opts.rejectFirst !== "none");
    this.reviews.push({ taskId: spec.task.id, attempt: spec.attempt, approved });
    return {
      approved,
      note: approved ? "looks good" : "add the missing test",
      tokens: 1,
      costUsd: 0,
    };
  }

  async merge(spec: MergeSpec) {
    return { files: [`merged/${spec.task.id}.md`], note: "merged" };
  }
}

function fakeVm(): VmManager {
  const quotas = {
    maxConcurrentExecsPerUser: 2,
    maxExecDurationMs: 300_000,
    maxOutputBytes: 1_000_000,
    diskQuotaMb: 0,
  };
  return {
    quotas,
    async ensure() {},
    async assertDiskQuota() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
  } as unknown as VmManager;
}

function setup(harness: FakeHarness, bus: TelemetryBus) {
  return new TeamManager({
    vm: fakeVm(),
    bus,
    harness,
    routerForUser: () => null,
    desktopMode: false,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the team run");
}

test("team: 3-task plan runs in parallel, one task is sent back, and the merge lands", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 25 });
  const manager = setup(harness, bus);
  const start = manager.start("alice", { prompt: "Build the onboarding flow", settings: { maxAgents: 3 } });
  assert.equal(start.accepted, true);

  const events: { type: string; data?: unknown }[] = [];
  bus.subscribe(start.runId, 0, (event) => events.push({ type: event.type, data: event.data }));

  const run = manager.get("alice")!;
  await waitFor(() => ["completed", "failed"].includes(manager.get("alice")!.status));

  const final = manager.get("alice")!;
  assert.equal(final.plan.length, 3);
  assert.equal(harness.maxActive, 3, "three lanes must run at the same time");
  assert.equal(final.concurrency.limit, 3);
  assert.equal(harness.attempts.get("a2"), 2, "t2 must be attempted twice (rework)");
  assert.equal(harness.reviews.filter((r) => r.taskId === "t2" && !r.approved).length, 1);
  assert.equal(final.status, "completed", final.error ?? "");
  assert.deepEqual(final.plan.map((task) => task.status), ["merged", "merged", "merged"]);
  assert.equal(final.mergedFiles.length, 3);

  const actions = events.map((event) => event.type);
  assert.ok(actions.includes("team.plan"), "team.plan event");
  assert.equal(actions.filter((type) => type === "team.agent.started").length, 3);
  assert.equal(actions.filter((type) => type === "team.review").length, 4);
  assert.equal(actions.filter((type) => type === "team.agent.finished").length, 3);
  assert.equal(actions[actions.length - 1], "run.finished");
});

test("team: concurrency is capped at the user setting", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 15, tasks: 4 });
  const manager = setup(harness, bus);
  const start = manager.start("bob", {
    prompt: "Four things",
    settings: { maxAgents: 2, maxTasks: 4 },
  });
  assert.equal(start.accepted, true);
  await waitFor(() => ["completed", "failed"].includes(manager.get("bob")!.status));

  const run = manager.get("bob")!;
  assert.equal(run.concurrency.limit, 2);
  assert.equal(harness.maxActive, 2, "never more than the user's cap");
  assert.equal(run.status, "completed", run.error ?? "");
  assert.equal(run.plan.length, 4);
});

test("team: the token budget stops the run before the next lane", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 5, tasks: 3, tokensPerLane: 600 });
  const manager = setup(harness, bus);
  const start = manager.start("carol", {
    prompt: "Three tiny tasks",
    settings: { maxAgents: 3, tokenCap: 1_100, maxAttempts: 1 },
  });
  assert.equal(start.accepted, true);
  await waitFor(() => ["completed", "failed"].includes(manager.get("carol")!.status));

  const run = manager.get("carol")!;
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /budget/i);
  assert.ok(run.budget.tokensUsed <= run.budget.tokenCap, "usage never passes the cap");
  assert.ok(harness.maxActive <= 2, "no third lane starts once the budget is spent");
  assert.equal(run.plan.filter((task) => task.status === "failed").length >= 1, true);
});

test("team: take-over pauses a lane and leaves its remaining task for the user", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 0, tasks: 4, blockLane: "a1" });
  const manager = setup(harness, bus);
  const start = manager.start("dave", {
    prompt: "Hold the first lane",
    settings: { maxAgents: 2, maxTasks: 4 },
  });
  const run = manager.get("dave")!;
  await waitFor(() => run.lanes.find((lane) => lane.agentId === "a1")?.status === "running");

  const taken = manager.takeOver("dave", start.runId, "a1");
  const paused = taken?.lanes.find((lane) => lane.agentId === "a1");
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.takenOver, true);
  harness.release();
  await waitFor(() => ["completed", "failed"].includes(manager.get("dave")!.status));

  const final = manager.get("dave")!;
  const lane = final.lanes.find((item) => item.agentId === "a1")!;
  assert.equal(lane.takenOver, true);
  // The lane gets no second task after the user takes over.
  assert.equal(final.plan.find((task) => task.agentId === "a1" && task.id === "t3")?.status, "pending");
});

test("team: only one team run is in flight per account", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 30 });
  const manager = setup(harness, bus);
  const first = manager.start("erin", { prompt: "First" });
  assert.equal(first.accepted, true);
  const second = manager.start("erin", { prompt: "Second" });
  assert.equal(second.accepted, false);
  assert.match(second.error ?? "", /already in flight/i);
  manager.cancel("erin");
});

test("team: the user's role pre-grants reach the planner and every lane", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 5, tasks: 2 });
  const manager = setup(harness, bus);
  const started = manager.start("grant-user", {
    prompt: "Use the extra access if needed",
    grantedRoleIds: ["deployer", "devops"],
    settings: { maxAgents: 2, maxTasks: 2 },
  });
  assert.equal(started.accepted, true);
  await waitFor(() => ["completed", "failed"].includes(manager.get("grant-user")!.status));

  assert.deepEqual(harness.planSpecs[0]?.grantedRoleIds, ["deployer", "devops"]);
  assert.ok(harness.laneSpecs.length > 0, "the team must have run lanes");
  for (const spec of harness.laneSpecs) {
    assert.deepEqual(spec.grantedRoleIds, ["deployer", "devops"]);
  }
});

test("team: the plan-review gate approves the first plan and records its turns", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 10 });
  const manager = setup(harness, bus);
  const start = manager.start("fay", { prompt: "Build the onboarding flow", settings: { maxAgents: 3 } });
  assert.equal(start.accepted, true);

  const events: { type: string; data?: unknown }[] = [];
  bus.subscribe(start.runId, 0, (event) => events.push({ type: event.type, data: event.data }));

  await waitFor(() => ["completed", "failed"].includes(manager.get("fay")!.status));

  const final = manager.get("fay")!;
  assert.equal(final.status, "completed", final.error ?? "");
  assert.equal(harness.planReviews.length, 1, "the plan is reviewed exactly once");
  assert.deepEqual(harness.planReviewSpecs[0]?.plan.map((task: TeamTask) => task.id), ["t1", "t2", "t3"]);
  assert.equal(harness.planReviewSpecs[0]?.attempt, 1);
  assert.deepEqual(final.planReview, { rounds: 1, approved: true, note: "plan covers the goal" });
  // Planner took one planning turn; the reworked lane took two turns.
  assert.equal(final.lanes.find((lane) => lane.agentId === "planner")?.turns, 1);
  assert.equal(final.lanes.find((lane) => lane.agentId === "a1")?.turns, 1);
  assert.equal(final.lanes.find((lane) => lane.agentId === "a2")?.turns, 2);
  assert.ok(
    events.some((event) => event.type === "team.plan.review"),
    "team.plan.review event",
  );
});

test("team: a rejected plan is revised once with the reviewer's note and then runs", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 5, rejectPlanRounds: 1 });
  const manager = setup(harness, bus);
  const start = manager.start("gus", { prompt: "Build the onboarding flow", settings: { maxAgents: 3 } });
  assert.equal(start.accepted, true);
  await waitFor(() => ["completed", "failed"].includes(manager.get("gus")!.status));

  const final = manager.get("gus")!;
  assert.equal(final.status, "completed", final.error ?? "");
  assert.equal(harness.planReviews.length, 2, "one rejection, one approval");
  assert.deepEqual(
    harness.planReviews.map((review) => review.approved),
    [false, true],
  );
  // The revision round re-plans with the reviewer's note, and the revised
  // plan is the one that runs.
  assert.equal(harness.planSpecs.length, 2);
  assert.equal(harness.planSpecs[1]?.revisionNote, "task B is too vague — split it");
  assert.ok(final.plan.every((task) => task.title.endsWith("(revised)")), "revised plan ran");
  assert.deepEqual(final.planReview, {
    rounds: 2,
    approved: true,
    note: "plan covers the goal",
  });
  assert.equal(final.lanes.find((lane) => lane.agentId === "planner")?.turns, 2);
  assert.ok(harness.laneSpecs.length > 0, "lanes started on the revised plan");
});

test("team: a twice-rejected plan fails the run before any lane starts", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new FakeHarness({ holdMs: 5, rejectPlanRounds: 2 });
  const manager = setup(harness, bus);
  const start = manager.start("hal", { prompt: "Build the onboarding flow", settings: { maxAgents: 3 } });
  assert.equal(start.accepted, true);
  await waitFor(() => ["completed", "failed"].includes(manager.get("hal")!.status));

  const final = manager.get("hal")!;
  assert.equal(final.status, "failed");
  assert.match(final.error ?? "", /plan rejected on review/i);
  assert.match(final.error ?? "", /task B is too vague/);
  assert.equal(harness.planReviews.length, 2, "exactly two review rounds, no more");
  assert.deepEqual(final.planReview, {
    rounds: 2,
    approved: false,
    note: "task B is too vague — split it",
  });
  assert.equal(harness.laneSpecs.length, 0, "no lane ever started");
  assert.equal(final.lanes.length, 1, "only the planner lane exists");
  assert.equal(final.lanes[0].status, "failed");
});
