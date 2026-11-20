/**
 * Tests for the TeamPanel click-to-inspect detail (the pure builder).
 *
 * The component itself has no DOM test setup (node:test, no jsdom), so the
 * inspectable facts are covered here and the panel is verified by typecheck.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildLaneInspectDetail } from "./teamLaneDetail";
import type { TeamLane, TeamTask } from "../../../lib/team/types";
import type { RoleDefinition } from "../../../lib/roles";

function lane(partial: Partial<TeamLane> = {}): TeamLane {
  return {
    agentId: "a1",
    kind: "worker",
    roleId: "implementer",
    roleName: "Implementer",
    glyph: "Im",
    taskId: "t1",
    taskTitle: "Task A",
    status: "running",
    currentAction: "Writing the code…",
    provider: "fake",
    model: "fake-model",
    worktree: "/workspace/team/r1/a1",
    attempts: 2,
    turns: 2,
    tokens: 1200,
    costUsd: 0.01,
    startedAt: 1000,
    finishedAt: null,
    takenOver: false,
    note: null,
    ...partial,
  };
}

function implementer(): RoleDefinition {
  return {
    id: "implementer",
    name: "Implementer",
    description: "Writes code",
    glyph: "Im",
    model: "",
    permissions: {
      readOnly: false,
      allowBash: true,
      allowWrite: true,
      allowNetwork: false,
      allowBrowser: false,
      allowSubagents: false,
    },
    tools: ["read_file", "write_file", "bash"],
    mcpServers: ["roles"],
    skills: [],
    instructions: "",
    category: "core",
    builtin: true,
  };
}

const tasks: TeamTask[] = [
  { id: "t1", title: "Task A", detail: "do a, thoroughly", roleId: "implementer", status: "active" },
  { id: "t2", title: "Task B", detail: "do b", roleId: "researcher", status: "pending" },
];

test("buildLaneInspectDetail joins the lane to its plan task and its role tools", () => {
  const detail = buildLaneInspectDetail(lane(), tasks, [implementer()]);
  assert.equal(detail.agentId, "a1");
  assert.equal(detail.taskTitle, "Task A");
  assert.equal(detail.taskDetail, "do a, thoroughly");
  assert.equal(detail.taskStatus, "active");
  assert.deepEqual(detail.tools, ["read_file", "write_file", "bash"]);
  assert.deepEqual(detail.mcpServers, ["roles"]);
  assert.equal(detail.customRole, false);
  assert.equal(detail.turns, 2);
  assert.equal(detail.worktree, "/workspace/team/r1/a1");
});

test("buildLaneInspectDetail falls back to the lane's own title when it has no plan task", () => {
  const detail = buildLaneInspectDetail(
    lane({ taskId: null, taskTitle: "Plan ready" }),
    tasks,
    [implementer()],
  );
  assert.equal(detail.taskTitle, "Plan ready");
  assert.equal(detail.taskDetail, null);
  assert.equal(detail.taskStatus, null);
});

test("buildLaneInspectDetail marks a custom role and leaves its tools empty", () => {
  const detail = buildLaneInspectDetail(
    lane({ roleId: "my-custom-role", roleName: "Custom" }),
    tasks,
    [implementer()],
  );
  assert.equal(detail.customRole, true);
  assert.deepEqual(detail.tools, []);
  assert.deepEqual(detail.mcpServers, []);
});

test("buildLaneInspectDetail falls back to attempts when turns is missing (old snapshot)", () => {
  const old = lane({ turns: undefined as unknown as number, attempts: 3 });
  const detail = buildLaneInspectDetail(old, tasks, [implementer()]);
  assert.equal(detail.turns, 3);
});
