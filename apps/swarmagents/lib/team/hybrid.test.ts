import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTaskText, partitionTeamLanes } from "./hybrid";
import { teleportAvailability } from "./teleport";

test("local inference and private edits classify as BYOC", () => {
  assert.equal(classifyTaskText("Index the repo and run local MLX inference"), "byoc");
  assert.equal(classifyTaskText("Edit the private-repo checkout with Ollama"), "byoc");
});

test("browser, Playwright, and Docker work classify as cloud", () => {
  assert.equal(classifyTaskText("Playwright E2E against the preview"), "cloud");
  assert.equal(classifyTaskText("Docker build of the worker image"), "cloud");
  assert.equal(classifyTaskText("browser scraping of the docs"), "cloud");
});

test("a task that names both kinds stays on cloud", () => {
  assert.equal(classifyTaskText("index the repo then docker build"), "cloud");
});

test("local work is placed on the paired computer and the rest on cloud", () => {
  const texts = [
    "heavy indexing with Ollama",
    "Playwright E2E",
    "Docker build",
    "private-repo edit",
  ];
  const lanes = partitionTeamLanes({
    taskCount: 4,
    texts,
    laneCount: 3,
    byocComputerId: "cmp_aabbccdd",
  });
  const byoc = lanes.find((lane) => lane.placement === "byoc");
  const cloud = lanes.filter((lane) => lane.placement === "cloud");
  assert.equal(byoc?.computeTarget, "computer:cmp_aabbccdd");
  assert.deepEqual([...(byoc?.taskIndexes ?? [])].sort(), [0, 3]);
  assert.deepEqual(cloud.flatMap((lane) => lane.taskIndexes).sort(), [1, 2]);
  assert.ok(cloud.every((lane) => lane.computeTarget === "cloud"));
});

test("a single mixed lane stays on cloud", () => {
  const lanes = partitionTeamLanes({
    taskCount: 2,
    texts: ["heavy indexing with Ollama", "Playwright E2E"],
    laneCount: 1,
    byocComputerId: "cmp_aabbccdd",
  });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].placement, "cloud");
  assert.deepEqual([...lanes[0].taskIndexes].sort(), [0, 1]);
});

test("a malformed computer id does not create a BYOC lane", () => {
  const lanes = partitionTeamLanes({
    taskCount: 1,
    texts: ["ollama inference"],
    laneCount: 2,
    byocComputerId: "not-a-computer",
  });
  assert.equal(lanes[0].placement, "cloud");
  assert.equal(lanes[0].computeTarget, "cloud");
});

test("teleport stays blocked until PR #95 is merged", () => {
  const status = teleportAvailability();
  assert.equal(status.available, false);
  assert.match(status.blockedBy, /#95/);
});
