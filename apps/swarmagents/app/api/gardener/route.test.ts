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

let tempDir: string;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gardener-route-test-"));
  configureGardenerDir(tempDir);
});

test.afterEach(() => {
  configureGardenerDir(null);
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

test("setElo rejects non-finite workerElo with status 400", async () => {
  for (const invalidElo of [NaN, Infinity, -Infinity, "not-a-number", null, undefined]) {
    const res = await post({ action: "setElo", workerElo: invalidElo });
    assert.equal(res.status, 400, `Expected 400 for workerElo: ${String(invalidElo)}`);
    const data = (await res.json()) as { error?: string };
    assert.match(data.error ?? "", /finite number/i);
  }
});

test("setElo clamps valid finite workerElo within [1000, 1800]", async () => {
  const resLow = await post({ action: "setElo", workerElo: 500 });
  assert.equal(resLow.status, 200);
  const dataLow = (await resLow.json()) as { workerElo: number };
  assert.equal(dataLow.workerElo, 1000);

  const resHigh = await post({ action: "setElo", workerElo: 2500 });
  assert.equal(resHigh.status, 200);
  const dataHigh = (await resHigh.json()) as { workerElo: number };
  assert.equal(dataHigh.workerElo, 1800);

  const resValid = await post({ action: "setElo", workerElo: 1542.4 });
  assert.equal(resValid.status, 200);
  const dataValid = (await resValid.json()) as { workerElo: number };
  assert.equal(dataValid.workerElo, 1542);
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
