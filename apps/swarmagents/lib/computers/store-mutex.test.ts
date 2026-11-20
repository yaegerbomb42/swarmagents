import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureComputersStoreDir,
  createPairingCodeAsync,
  redeemPairingCodeAsync,
  recordHeartbeatAsync,
  listComputers,
  userComputersFilePath,
} from "./store";

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-computers-mutex-test-"));
  configureComputersStoreDir(dir);
});

test.afterEach(() => {
  configureComputersStoreDir("");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("computers store: concurrent pairing creation and redemption does not clobber state", async () => {
  const userId = "alice";
  const numPairings = 5;

  const pairings = await Promise.all(
    Array.from({ length: numPairings }, () => createPairingCodeAsync(userId))
  );

  assert.equal(pairings.length, numPairings);

  // Redeem all pairings concurrently
  const redeemed = await Promise.all(
    pairings.map((p, i) =>
      redeemPairingCodeAsync(p.code, {
        name: `Node ${i}`,
        os: "linux",
        mode: "host",
      })
    )
  );

  for (const r of redeemed) {
    assert.ok(r, "each pairing should successfully redeem");
  }

  const computers = listComputers(userId);
  assert.equal(computers.length, numPairings);

  // Concurrent heartbeats from all nodes
  await Promise.all(
    redeemed.map((r, i) =>
      recordHeartbeatAsync(r!.computer.id, r!.nodeToken, {
        name: `Node ${i}`,
        os: "linux",
        cpuCores: 8 + i,
        mode: "host",
      })
    )
  );

  const updatedComputers = listComputers(userId);
  assert.equal(updatedComputers.length, numPairings);
  for (let i = 0; i < numPairings; i++) {
    const found = updatedComputers.find((c) => c.name === `Node ${i}`);
    assert.ok(found);
    assert.equal(found.cpuCores, 8 + i);
  }

  // Verify file mode is 0o600
  const filePath = userComputersFilePath(userId);
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600);
});
