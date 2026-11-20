// Team Mode — a lane's approval reaches the team snapshot (the panel).
//
// The panel renders the pending approval of a lane, so the run snapshot must
// carry it while the lane waits, and drop it once the decision lands.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TelemetryEvent as HarnessEvent } from "../harness/types";
import { TelemetryBus } from "../telemetry/bus";
import type { VmManager } from "../vm/manager";
import type { LaneSpec, MergeSpec, PlanReviewSpec, PlanSpec, ReviewSpec, TeamHarness } from "./harness";
import { TeamManager } from "./manager";
import type { LaneResult, PlanDraft } from "./types";

const APPROVAL_ID = "appr_lane_test";

/** A harness whose lane asks for approval and waits for the decision. */
class ApprovingHarness implements TeamHarness {
  readonly id = "approving";
  private release: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async plan(_spec: PlanSpec): Promise<PlanDraft[]> {
    return [
      { title: "Task A", detail: "do A", roleId: "implementer" },
      { title: "Task B", detail: "do B", roleId: "implementer" },
    ];
  }

  async reviewPlan(_spec: PlanReviewSpec) {
    return { approved: true, note: "ok", tokens: 0, costUsd: 0 };
  }

  async lane(spec: LaneSpec): Promise<LaneResult> {
    spec.onEvent?.({
      type: "approval.required",
      approval: {
        id: APPROVAL_ID,
        tool: "Bash",
        action: "rm -rf /",
        reason: "destructive root deletion requires approval",
        riskLevel: "ask",
        expiresAt: Date.now() + 60_000,
      },
    });
    await this.gate;
    spec.onEvent?.({ type: "approval.resolved", id: APPROVAL_ID, verdict: "approved" });
    return { ok: true, summary: `${spec.agentId} done`, files: [], tokens: 1, costUsd: 0 };
  }

  async review(_spec: ReviewSpec) {
    return { approved: true, note: "ok", tokens: 0, costUsd: 0 };
  }

  async merge(_spec: MergeSpec) {
    return { files: [], note: "merged" };
  }

  releaseLane(): void {
    this.release?.();
  }
}

function fakeVm(): VmManager {
  return {
    quotas: {
      maxConcurrentExecsPerUser: 2,
      maxExecDurationMs: 300_000,
      maxOutputBytes: 1_000_000,
      diskQuotaMb: 0,
    },
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

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the team run");
}

test("team: a lane's pending approval shows up in the snapshot and clears on the decision", async () => {
  const bus = new TelemetryBus({ persist: false });
  const harness = new ApprovingHarness();
  const manager = new TeamManager({
    vm: fakeVm(),
    bus,
    harness,
    routerForUser: () => null,
    desktopMode: false,
  });

  const start = manager.start("erin", { prompt: "Two things", settings: { maxAgents: 2 } });
  assert.equal(start.accepted, true);

  const events: { type: string }[] = [];
  bus.subscribe(start.runId, 0, (event) => events.push({ type: event.type }));

  // The lane is paused on the approval: the snapshot carries it.
  await waitFor(() =>
    manager
      .get("erin")!
      .lanes.some((lane) => lane.approval?.id === APPROVAL_ID),
  );
  const waiting = manager.get("erin")!.lanes.find((lane) => lane.approval?.id === APPROVAL_ID)!;
  assert.equal(waiting.approval?.tool, "Bash");
  assert.equal(waiting.approval?.action, "rm -rf /");
  assert.match(waiting.approval?.reason ?? "", /approval/i);
  assert.ok(
    events.some((event) => event.type === "approval.required"),
    "the approval must reach the run stream",
  );

  harness.releaseLane();
  await waitFor(() => manager.get("erin")!.lanes.every((lane) => !lane.approval));
  await waitFor(() => ["completed", "failed"].includes(manager.get("erin")!.status));
});
