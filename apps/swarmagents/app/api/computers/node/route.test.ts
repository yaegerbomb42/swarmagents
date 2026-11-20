import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { computerAuth } from "../../../../lib/computers/node-token";
import { TelemetryBus } from "../../../../lib/telemetry/bus";
import {
  configureComputersClock,
  configureComputersStoreDir,
  createPairingCode,
  redeemPairingCode,
} from "../../../../lib/computers/store";
import {
  RemoteRunManager,
  setRemoteRunManagerForTesting,
  resetRemoteRunManagerForTesting,
} from "../../../../lib/computers/remote";

function post(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/computers/node", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action: "heartbeat", computerId: "cmp_0123456789abcdef" }),
  });
}

test("a non-hex x-computer-token is rejected like a bad bearer and never hits the store", async () => {
  let storeCalls = 0;
  mock.method(computerAuth, "authenticate", () => {
    storeCalls += 1;
    return null;
  });
  try {
    const badBearer = await POST(post({ authorization: "Bearer not-a-token" }));
    const badFallback = await POST(post({ "x-computer-token": "not-hex-token" }));
    const bearerBody = await badBearer.json();
    const fallbackBody = await badFallback.json();
    assert.equal(badBearer.status, 401);
    assert.equal(badFallback.status, 401);
    assert.deepEqual(fallbackBody, bearerBody);
    assert.deepEqual(bearerBody, { error: "Unknown or revoked computer." });
    assert.equal(storeCalls, 0);
  } finally {
    mock.restoreAll();
  }
});

test("a 64-hex x-computer-token is passed to the store", async () => {
  const seen: unknown[] = [];
  mock.method(computerAuth, "authenticate", (_id: unknown, token: unknown) => {
    seen.push(token);
    return null;
  });
  try {
    const token = "ab".repeat(32);
    const res = await POST(post({ "x-computer-token": `  ${token}  ` }));
    assert.equal(res.status, 401);
    assert.deepEqual(seen, [token]);
  } finally {
    mock.restoreAll();
  }
});

test("batch events: accepted events publish, per-entry failures are counted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-node-batch-"));
  configureComputersStoreDir(dir);
  let now = 1_000_000;
  configureComputersClock(() => now);
  const bus = new TelemetryBus({ persist: false });
  const manager = new RemoteRunManager({ bus, autoSweep: false });
  setRemoteRunManagerForTesting(manager);
  try {
    const pairing = createPairingCode("alice");
    const redeemed = redeemPairingCode(pairing.code, { name: "Build box", os: "linux", mode: "host" });
    assert.ok(redeemed);
    const computerId = redeemed.computer.id;
    const token = redeemed.nodeToken;

    const started = manager.start("alice", { prompt: "Run it", computerId });
    assert.ok(started.accepted, "the remote run must start");
    const claimed = manager.claim("alice", computerId);
    assert.ok(claimed);

    const seen: string[] = [];
    bus.subscribe(started.runId, 0, (event) => seen.push(event.type));

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-computer-id": computerId,
    };
    const call = (body: unknown) =>
      POST(
        new NextRequest("http://localhost/api/computers/node", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );

    const batch = await call({
      action: "events",
      events: [
        { runId: started.runId, event: { type: "assistant.text", text: "one" } },
        { runId: started.runId, event: { type: "tool.call", name: "Read", input: { path: "package.json" } } },
        { runId: started.runId, event: { type: "assistant.text", text: "two" } },
      ],
    });
    assert.equal(batch.status, 200);
    const batchBody = await batch.json();
    assert.deepEqual({ accepted: batchBody.accepted, rejected: batchBody.rejected }, { accepted: 3, rejected: 0 });
    assert.deepEqual(seen, ["run.created", "run.queued", "run.started", "assistant.text", "tool.call", "assistant.text"]);

    const mixed = await call({
      action: "events",
      events: [
        { runId: started.runId, event: { type: "assistant.text", text: "three" } },
        { event: { type: "assistant.text", text: "no runId" } },
        { runId: started.runId, event: { type: "run.finished" } }, // forged lifecycle event: rejected
      ],
    });
    assert.equal(mixed.status, 200);
    const mixedBody = await mixed.json();
    assert.deepEqual({ accepted: mixedBody.accepted, rejected: mixedBody.rejected }, { accepted: 1, rejected: 2 });

    const oversize = await call({
      action: "events",
      events: Array.from({ length: 65 }, () => ({ runId: started.runId, event: { type: "assistant.text", text: "x" } })),
    });
    assert.equal(oversize.status, 400);
  } finally {
    manager.stop();
    setRemoteRunManagerForTesting(null);
    resetRemoteRunManagerForTesting();
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
