import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST, GET } from "./route";
import { MAX_REPO_ROOT_LEN, MAX_PINNED_REPOSITORIES } from "@/lib/gardener/types";
import { configureGardenerDir, readUserGardener, updateUserGardener } from "@/lib/gardener/store";
import type { GardenerProposal } from "@/lib/gardener/types";
import { DEFAULT_MAX_JSON_BODY_BYTES } from "@/lib/http";
import { configureAuditPath, readAuditEntries } from "@/lib/audit";

let tempDir: string;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-route-test-"));
  configureGardenerDir(tempDir);
  configureAuditPath(path.join(tempDir, "audit.jsonl"));
});

test.afterEach(() => {
  configureGardenerDir(null);
  configureAuditPath(undefined);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return POST(
    new NextRequest("http://localhost/api/gardener", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: payload,
    }),
  );
}

/** A proposal row as the autopilot tick would write it. */
function proposal(overrides: Partial<GardenerProposal> = {}): GardenerProposal {
  return {
    id: "prop_1",
    userId: "local",
    kind: "unit-test",
    title: "Add a test for the parser",
    summary: "The parser has no coverage.",
    status: "awaiting_approval",
    createdAt: Date.now(),
    ...overrides,
  };
}

test("rejects an oversized body with status 413", async () => {
  const hugeBody = JSON.stringify({
    action: "pin",
    repoRoot: "/workspace/demo",
    padding: "x".repeat(DEFAULT_MAX_JSON_BODY_BYTES + 1024),
  });
  const res = await post(hugeBody);
  assert.equal(res.status, 413);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /too large/i);
});

test("rejects malformed or empty body with status 400", async () => {
  const res = await post("{invalid-json");
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /Invalid JSON body/i);
});

test("rejects non-object body with status 400", async () => {
  const res = await post(JSON.stringify(["action", "pin"]));
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /Body must be a JSON object/i);
});

test("setDifficulty rejects anything outside easy/medium/hard with status 400", async () => {
  for (const invalid of ["trivial", "expert", "1400", 1400, null, undefined]) {
    const res = await post({ action: "setDifficulty", maxDifficulty: invalid });
    assert.equal(res.status, 400, `Expected 400 for maxDifficulty: ${String(invalid)}`);
    const data = (await res.json()) as { error?: string };
    assert.match(data.error ?? "", /maxDifficulty must be one of easy, medium, hard/i);
  }
});

test("setDifficulty stores the chosen max difficulty", async () => {
  const res = await post({ action: "setDifficulty", maxDifficulty: "hard" });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { maxDifficulty?: string };
  assert.equal(data.maxDifficulty, "hard");
});

test("pin rejects repoRoot outside /workspace with status 400", async () => {
  const outsidePaths = [
    "/etc/passwd",
    "../secret",
    "/var/log",
    "/workspace/../../outside",
    "/workspace/../etc",
  ];
  for (const badPath of outsidePaths) {
    const res = await post({ action: "pin", repoRoot: badPath });
    assert.equal(res.status, 400, `Expected 400 for path: ${badPath}`);
    const data = (await res.json()) as { error?: string };
    assert.ok(data.error, `Expected error message for path: ${badPath}`);
  }
});

test("pin rejects overlong repoRoot with status 400", async () => {
  const longSegment = "a".repeat(MAX_REPO_ROOT_LEN);
  const overlongPath = `/workspace/${longSegment}`;
  assert.ok(overlongPath.length > MAX_REPO_ROOT_LEN);

  const res = await post({ action: "pin", repoRoot: overlongPath });
  assert.equal(res.status, 400);
  const data = (await res.json()) as { error?: string };
  assert.match(data.error ?? "", /exceeds maximum length/i);
});

test("pin normalizes path under /workspace and records it", async () => {
  const res = await post({ action: "pin", repoRoot: "my-project/sub" });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { pinned: Array<{ repoRoot: string; pinnedAt: number }> };
  assert.equal(data.pinned.length, 1);
  assert.equal(data.pinned[0].repoRoot, "/workspace/my-project/sub");

  // Idempotent pin
  const res2 = await post({ action: "pin", repoRoot: "/workspace/my-project/sub/" });
  assert.equal(res2.status, 200);
  const data2 = (await res2.json()) as { pinned: Array<{ repoRoot: string; pinnedAt: number }> };
  assert.equal(data2.pinned.length, 1);
});

test("pin enforces maximum number of pinned repositories per user", async () => {
  for (let i = 0; i < MAX_PINNED_REPOSITORIES; i++) {
    const res = await post({ action: "pin", repoRoot: `/workspace/repo-${i}` });
    assert.equal(res.status, 200);
  }

  const overflowRes = await post({ action: "pin", repoRoot: "/workspace/repo-overflow" });
  assert.equal(overflowRes.status, 400);
  const data = (await overflowRes.json()) as { error?: string };
  assert.match(data.error ?? "", /maximum number of pinned repositories/i);

  // Pinning an already pinned repository should still succeed without error
  const existingRes = await post({ action: "pin", repoRoot: "/workspace/repo-0" });
  assert.equal(existingRes.status, 200);
});

test("pin then unpin removes the repository and the proposals scoped to it", async () => {
  const pinned = await post({ action: "pin", repoRoot: "/workspace/keeper" });
  assert.equal(pinned.status, 200);
  const kept = await post({ action: "pin", repoRoot: "/workspace/other" });
  assert.equal(kept.status, 200);

  // Proposals are produced by the autopilot tick; seed them directly.
  updateUserGardener("local", (state) => {
    state.proposals.push(
      proposal({ id: "prop_keeper_1", repoRoot: "/workspace/keeper" }),
      proposal({ id: "prop_keeper_2", repoRoot: "/workspace/keeper" }),
      proposal({ id: "prop_other", repoRoot: "/workspace/other" }),
    );
  });

  const res = await post({ action: "unpin", repoRoot: "/workspace/keeper/" });
  assert.equal(res.status, 200);
  const state = (await res.json()) as {
    pinned: Array<{ repoRoot: string }>;
    proposals: Array<{ id: string }>;
  };
  assert.deepEqual(state.pinned.map((row) => row.repoRoot), ["/workspace/other"]);
  assert.deepEqual(state.proposals.map((row) => row.id), ["prop_other"]);
  assert.deepEqual(readUserGardener("local").pinned.map((row) => row.repoRoot), ["/workspace/other"]);

  // Unpinning again is not a no-op success: nothing is pinned under that root.
  const again = await post({ action: "unpin", repoRoot: "/workspace/keeper" });
  assert.equal(again.status, 404);
});

test("unpin validates repoRoot like pin", async () => {
  const outside = await post({ action: "unpin", repoRoot: "/etc/passwd" });
  assert.equal(outside.status, 400);

  const missing = await post({ action: "unpin" });
  assert.equal(missing.status, 400);
  const data = (await missing.json()) as { error?: string };
  assert.match(data.error ?? "", /repoRoot required/i);
});

test("removeProposal removes exactly one proposal", async () => {
  updateUserGardener("local", (state) => {
    state.proposals.push(
      proposal({ id: "prop_a" }),
      proposal({ id: "prop_b" }),
    );
  });

  const res = await post({ action: "removeProposal", proposalId: "prop_a" });
  assert.equal(res.status, 200);
  const state = (await res.json()) as { proposals: Array<{ id: string }> };
  assert.deepEqual(state.proposals.map((row) => row.id), ["prop_b"]);
  assert.deepEqual(readUserGardener("local").proposals.map((row) => row.id), ["prop_b"]);

  const missing = await post({ action: "removeProposal", proposalId: "prop_a" });
  assert.equal(missing.status, 404);

  const noId = await post({ action: "removeProposal" });
  assert.equal(noId.status, 400);
  const data = (await noId.json()) as { error?: string };
  assert.match(data.error ?? "", /proposalId required/i);
});

test("setEnabled writes a gardener.autopilot audit entry", async () => {
  const res = await post({ action: "setEnabled", enabled: true });
  assert.equal(res.status, 200);
  const entries = readAuditEntries("local");
  const hit = entries.find((e) => e.action === "gardener.autopilot");
  assert.ok(hit);
  assert.equal(hit!.target, "enabled");
  assert.equal(hit!.result, "success");

  const off = await post({ action: "setEnabled", enabled: false });
  assert.equal(off.status, 200);
  const again = readAuditEntries("local").filter((e) => e.action === "gardener.autopilot");
  assert.ok(again.some((e) => e.target === "disabled"));
});

test("setEnabled validates that enabled is strictly a boolean", async () => {
  for (const bad of ["true", "false", 1, 0, null, undefined, {}]) {
    const res = await post({ action: "setEnabled", enabled: bad });
    assert.equal(res.status, 400, `Expected 400 for enabled: ${JSON.stringify(bad)}`);
    const data = (await res.json()) as { error?: string };
    assert.match(data.error ?? "", /boolean/i);
  }

  const resTrue = await post({ action: "setEnabled", enabled: true });
  assert.equal(resTrue.status, 200);
  assert.equal(((await resTrue.json()) as { enabled: boolean }).enabled, true);

  const resFalse = await post({ action: "setEnabled", enabled: false });
  assert.equal(resFalse.status, 200);
  assert.equal(((await resFalse.json()) as { enabled: boolean }).enabled, false);
});

test("tick has rate-limiting and returns no-store", async () => {
  const res1 = await post({ action: "tick" });
  assert.equal(res1.headers.get("cache-control"), "no-store");
  // Second immediate tick must trigger rate limit 429
  const res2 = await post({ action: "tick" });
  assert.equal(res2.status, 429);
  assert.equal(res2.headers.get("cache-control"), "no-store");
});
