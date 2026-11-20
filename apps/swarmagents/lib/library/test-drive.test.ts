/**
 * F4 — test-drive store + prompt: snapshot labels, the drive marker, the
 * inline item content, and the record lifecycle.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLibraryStoreDir } from "./user-store";
import {
  DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS,
  MAX_TEST_DRIVE_ITEM_CHARS,
  createTestDrive,
  getTestDrive,
  listTestDrivesForUser,
  sweepAbandonedDrives,
  testDriveMarker,
  testDrivePrompt,
  testDriveSnapshotLabel,
  updateTestDrive,
} from "./test-drive";
import type { LibraryPayload } from "./types";

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-drive-"));
  configureLibraryStoreDir(dir);
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function skillPayload(markdown = "# Try me\n\nDo the thing."): LibraryPayload {
  return { kind: "skill", skillMd: markdown, files: [], requiredFields: [] };
}

test("snapshot labels fit the driver charset", () => {
  for (let i = 0; i < 20; i++) {
    const label = testDriveSnapshotLabel();
    assert.match(label, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.ok(!label.includes(".."));
    assert.ok(label.startsWith("test-drive-"));
    assert.ok(label.length <= 64);
  }
  const labels = new Set(Array.from({ length: 20 }, () => testDriveSnapshotLabel()));
  assert.equal(labels.size, 20);
});

test("the drive prompt marks the run and inlines the item without installing it", () => {
  const prompt = testDrivePrompt({
    publicId: "pub_abc",
    name: "Try me",
    kind: "skill",
    version: 3,
    payload: skillPayload(),
  });
  assert.ok(prompt.includes(testDriveMarker("pub_abc")));
  assert.ok(prompt.includes('"Try me"'));
  assert.ok(prompt.includes("v3"));
  assert.ok(prompt.includes("# Try me"));
  assert.ok(prompt.includes("snapshotted before you started"));
  assert.ok(prompt.includes("Do not install anything permanently"));
});

test("the drive prompt caps huge item content", () => {
  const prompt = testDrivePrompt({
    publicId: "pub_abc",
    name: "Huge",
    kind: "skill",
    version: 1,
    payload: skillPayload(`# Huge\n\n${"x".repeat(MAX_TEST_DRIVE_ITEM_CHARS * 2)}`),
  });
  assert.ok(prompt.length < MAX_TEST_DRIVE_ITEM_CHARS + 2000);
  assert.ok(!prompt.includes("x".repeat(MAX_TEST_DRIVE_ITEM_CHARS + 1)));
});

test("tool and MCP items render their definitions into the prompt", () => {
  const toolPrompt = testDrivePrompt({
    publicId: "pub_tool",
    name: "Adder",
    kind: "tool",
    version: 1,
    payload: {
      kind: "tool",
      language: "javascript",
      code: "return { sum: args.a + args.b };",
      inputSchema: { type: "object", properties: {} },
      requiredFields: [],
      timeoutMs: 5000,
    },
  });
  assert.ok(toolPrompt.includes("return { sum: args.a + args.b };"));
  const mcpPrompt = testDrivePrompt({
    publicId: "pub_mcp",
    name: "Server",
    kind: "mcp",
    version: 1,
    payload: { kind: "mcp", transport: "http", url: "https://example.test/mcp", requiredFields: [] },
  });
  assert.ok(mcpPrompt.includes("https://example.test/mcp"));
});

test("drive records round-trip and stay per-account", () => {
  const drive = createTestDrive({
    userId: "local_alice@example.com",
    publicId: "pub_abc",
    publicName: "Try me",
    version: 1,
    snapshotLabel: "test-drive-aaaaaaaa",
    runId: "run_drive_1",
  });
  assert.equal(drive.status, "running");
  assert.ok(drive.id.startsWith("td_"));
  assert.equal(getTestDrive(drive.id)?.runId, "run_drive_1");
  assert.equal(listTestDrivesForUser("local_alice@example.com").length, 1);
  assert.equal(listTestDrivesForUser("local_bob@example.com").length, 0);

  const updated = updateTestDrive(drive.id, { status: "kept", finishedAt: 123 });
  assert.equal(updated?.status, "kept");
  assert.equal(updated?.finishedAt, 123);
  assert.equal(getTestDrive(drive.id)?.status, "kept");
  assert.equal(getTestDrive("td_missing"), null);
  assert.equal(updateTestDrive("td_missing", { status: "kept" }), null);
});

// ---------------------------------------------------------------------------
// sweepAbandonedDrives
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function seedingDrive(
  runId: string,
  input: { status: "running" | "awaiting-decision" | "kept" | "rolled-back"; ageDays: number },
): string {
  const drive = createTestDrive({
    userId: "local_alice@example.com",
    publicId: "pub_abc",
    publicName: "Try me",
    version: 1,
    snapshotLabel: `test-drive-${runId}`,
    runId,
  });
  updateTestDrive(drive.id, {
    status: input.status,
    startedAt: NOW - input.ageDays * DAY_MS,
    finishedAt: input.status === "running" ? undefined : NOW - input.ageDays * DAY_MS,
  });
  return drive.id;
}

test("sweepAbandonedDrives rolls back only stale awaiting-decision drives", async () => {
  const fresh = seedingDrive("run_fresh", { status: "awaiting-decision", ageDays: 1 });
  const stale = seedingDrive("run_stale", { status: "awaiting-decision", ageDays: 8 });
  const running = seedingDrive("run_running", { status: "running", ageDays: 30 });
  const kept = seedingDrive("run_kept", { status: "kept", ageDays: 30 });

  const restored: string[] = [];
  const result = await sweepAbandonedDrives(
    "local_alice@example.com",
    async (drive) => {
      restored.push(drive.id);
    },
    { now: NOW },
  );
  assert.deepEqual(result, { swept: [stale], failed: [] });
  assert.deepEqual(restored, [stale]);
  assert.equal(getTestDrive(stale)?.status, "rolled-back");
  assert.equal(getTestDrive(stale)?.rollbackReason, "abandoned");
  assert.equal(getTestDrive(stale)?.finishedAt, NOW);
  assert.equal(getTestDrive(fresh)?.status, "awaiting-decision");
  assert.equal(getTestDrive(running)?.status, "running");
  assert.equal(getTestDrive(kept)?.status, "kept");
});

test("sweepAbandonedDrives sweeps oldest first and keeps going past a failure", async () => {
  const older = seedingDrive("run_older", { status: "awaiting-decision", ageDays: 10 });
  const newer = seedingDrive("run_newer", { status: "awaiting-decision", ageDays: 8 });
  const broken = seedingDrive("run_broken", { status: "awaiting-decision", ageDays: 9 });

  const restored: string[] = [];
  const result = await sweepAbandonedDrives(
    "local_alice@example.com",
    async (drive) => {
      if (drive.id === broken) throw new Error("restore exploded");
      restored.push(drive.id);
    },
    { now: NOW },
  );
  // Oldest first: older (10d), broken (9d, fails), newer (8d) — the failure
  // does not stop the sweep.
  assert.deepEqual(restored, [older, newer]);
  assert.deepEqual(result.swept, [older, newer]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.id, broken);
  assert.match(result.failed[0]?.error ?? "", /restore exploded/);
  assert.equal(getTestDrive(broken)?.status, "awaiting-decision");
  assert.match(getTestDrive(broken)?.lastError ?? "", /restore exploded/);
});

test("sweepAbandonedDrives honors a custom maxAgeMs", async () => {
  const twoDays = seedingDrive("run_two", { status: "awaiting-decision", ageDays: 2 });
  const result = await sweepAbandonedDrives(
    "local_alice@example.com",
    async () => {},
    { now: NOW, maxAgeMs: 3 * DAY_MS },
  );
  assert.deepEqual(result, { swept: [], failed: [] });
  assert.equal(getTestDrive(twoDays)?.status, "awaiting-decision");

  const swept = await sweepAbandonedDrives(
    "local_alice@example.com",
    async () => {},
    { now: NOW, maxAgeMs: 1 * DAY_MS },
  );
  assert.deepEqual(swept.swept, [twoDays]);
  assert.equal(DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS, 7 * DAY_MS);
});
