import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ONLINE_WINDOW_MS,
  PAIRING_TTL_MS,
  authenticateComputer,
  clearComputerIndex,
  configureComputersClock,
  configureComputersStoreDir,
  createPairingCode,
  formatPairingCode,
  getComputer,
  isOnline,
  listComputers,
  recordHeartbeat,
  redeemPairingCode,
  renameComputer,
  revokeComputer,
  userComputersFilePath,
} from "./store";

function withStore(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-computers-"));
  configureComputersStoreDir(dir);
  configureComputersClock(() => 1_000_000);
  try {
    fn(dir);
  } finally {
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("computers store: pairing code redeems once and yields an online computer", () => {
  withStore(() => {
    const pairing = createPairingCode("alice");
    assert.match(pairing.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    assert.equal(formatPairingCode(pairing.code.replace("-", "")), pairing.code);

    const redeemed = redeemPairingCode(pairing.code, {
      name: "Studio Mac",
      os: "darwin",
      arch: "arm64",
      cpuCores: 10,
      memoryMb: 32768,
      mode: "host",
      version: "1.2.3",
    });
    assert.ok(redeemed);
    assert.equal(redeemed.userId, "alice");
    assert.match(redeemed.nodeToken, /^[a-f0-9]{64}$/);
    assert.equal(redeemed.computer.name, "Studio Mac");
    assert.equal(redeemed.computer.os, "macos");
    assert.equal(redeemed.computer.mode, "host");
    assert.equal(redeemed.computer.cpuCores, 10);
    assert.equal(redeemed.computer.online, true);
    // The token hash, never the token, is on disk.
    const raw = fs.readFileSync(userComputersFilePath("alice"), "utf-8");
    assert.equal(raw.includes(redeemed.nodeToken), false);
    assert.match(raw, /"nodeTokenHash": ?"[a-f0-9]{64}"/);
    const stat = fs.statSync(userComputersFilePath("alice"));
    assert.equal(stat.mode & 0o077, 0);

    // Codes are single use and normalization tolerates spaces/lowercase.
    assert.equal(redeemPairingCode(pairing.code.toLowerCase().replace("-", " ")), null);
    assert.equal(listComputers("alice").length, 1);
    assert.equal(listComputers("bob").length, 0);
  });
});

test("computers store: expired codes and wrong codes do not pair", () => {
  withStore(() => {
    const pairing = createPairingCode("alice");
    // The clock is private to this helper; expiry is asserted through a second
    // code with a fake clock advanced past the TTL.
    configureComputersClock(() => 1_000_000 + PAIRING_TTL_MS + 1);
    assert.equal(redeemPairingCode(pairing.code), null);
    assert.equal(redeemPairingCode("AAAAA-AAAAA"), null);
    assert.equal(redeemPairingCode("short"), null);
    assert.equal(redeemPairingCode(42), null);
    assert.deepEqual(listComputers("alice"), []);
  });
});

test("computers store: heartbeat keeps a node online, rename is user-owned", () => {
  withStore(() => {
    const pairing = createPairingCode("alice");
    const redeemed = redeemPairingCode(pairing.code, { name: "Build box", os: "linux", mode: "container" });
    assert.ok(redeemed);
    const { id } = redeemed.computer;
    const token = redeemed.nodeToken;

    assert.deepEqual(authenticateComputer(id, token)?.computer.id, id);
    assert.equal(authenticateComputer(id, "0".repeat(64)), null);
    assert.equal(authenticateComputer(id, "not-a-token"), null);

    // 61 seconds later the node is offline until it heartbeats.
    configureComputersClock(() => 1_000_000 + ONLINE_WINDOW_MS + 1);
    assert.equal(getComputer("alice", id)?.online, false);
    assert.equal(isOnline(1_000_000), false);

    const beat = recordHeartbeat(id, token, { name: "Ignored heartbeat name", os: "linux", cpuCores: 4, memoryMb: 8192 });
    assert.ok(beat);
    assert.equal(beat.computer.online, true);
    assert.equal(beat.computer.name, "Build box");
    assert.equal(beat.computer.cpuCores, 4);

    const renamed = renameComputer("alice", id, "  Living-room PC  ");
    assert.equal(renamed?.name, "Living-room PC");
    // Another account cannot rename or revoke it.
    assert.equal(renameComputer("bob", id, "Mine now"), null);
    assert.equal(revokeComputer("bob", id), false);
    assert.throws(() => renameComputer("alice", id, "   "), /name is required/i);
  });
});

test("computers store: a 1 ms backward clock skew does not mark a fresh heartbeat offline", () => {
  const now = 2_000_000;
  // lastSeenAt is 1 ms ahead of "now" (peer clock lag / NTP tick). The heartbeat
  // is fresh and must still report online, not be falsely marked offline.
  assert.equal(isOnline(now + 1, now), true);
  // A wildly-future timestamp is still not "online" — the fix must not open the
  // window to arbitrary future heartbeats.
  assert.equal(isOnline(now + 60 * 60 * 1000, now), false);
});

test("computers store: revoke removes the token and the record", () => {
  withStore(() => {
    const pairing = createPairingCode("alice");
    const redeemed = redeemPairingCode(pairing.code, { name: "Old laptop", os: "linux" });
    assert.ok(redeemed);
    const { id } = redeemed.computer;
    assert.equal(revokeComputer("alice", id), true);
    assert.equal(revokeComputer("alice", id), false);
    assert.equal(getComputer("alice", id), null);
    assert.equal(authenticateComputer(id, redeemed.nodeToken), null);
    assert.equal(recordHeartbeat(id, redeemed.nodeToken, { os: "linux" }), null);
  });
});

test("computers store: malformed machine facts are clamped and files stay per-account", () => {
  withStore((dir) => {
    const pairing = createPairingCode("alice");
    const redeemed = redeemPairingCode(pairing.code, {
      name: "x".repeat(200),
      os: "plan9",
      cpuCores: -4,
      memoryMb: 12,
      mode: "toaster",
      version: "v".repeat(100),
    });
    assert.ok(redeemed);
    assert.equal(redeemed.computer.os, "linux");
    assert.equal(redeemed.computer.mode, "host");
    assert.equal(redeemed.computer.name.length, 60);
    assert.equal(redeemed.computer.cpuCores, undefined);
    assert.equal(redeemed.computer.memoryMb, undefined);
    assert.ok((redeemed.computer.version ?? "").length <= 40);

    const file = path.join(dir, "users");
    assert.ok(fs.existsSync(file));
    // Only the account that created it can list it.
    assert.equal(listComputers("alice").length, 1);
    assert.equal(listComputers("carol").length, 0);
  });
});

test("computers store: authenticateComputer and recordHeartbeat read only the owning user file (O(1))", () => {
  withStore((dir) => {
    // Create computers for 3 different users: alice, bob, carol
    const pAlice = createPairingCode("alice");
    const rAlice = redeemPairingCode(pAlice.code, { name: "Alice PC", os: "linux" });
    assert.ok(rAlice);

    const pBob = createPairingCode("bob");
    const rBob = redeemPairingCode(pBob.code, { name: "Bob Mac", os: "macos" });
    assert.ok(rBob);

    const pCarol = createPairingCode("carol");
    const rCarol = redeemPairingCode(pCarol.code, { name: "Carol PC", os: "windows" });
    assert.ok(rCarol);

    // Spy on fs.readFileSync
    const originalReadFileSync = fs.readFileSync;
    const readPaths: string[] = [];

    const hook = (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => {
      const p = String(args[0]);
      if (p.includes(dir) && p.endsWith("computers.json")) {
        readPaths.push(p);
      }
      return originalReadFileSync(...args);
    };

    fs.readFileSync = hook as unknown as typeof fs.readFileSync;

    try {
      // 1. Hot cache test: authenticateComputer for Bob should only read Bob's file
      readPaths.length = 0;
      const authBob = authenticateComputer(rBob.computer.id, rBob.nodeToken);
      assert.ok(authBob);
      assert.equal(authBob.userId, "bob");
      assert.equal(readPaths.length, 1);
      assert.equal(readPaths[0], userComputersFilePath("bob"));

      // 2. Hot cache test: recordHeartbeat for Alice should only read Alice's file (authenticate reads 1, recordHeartbeat reads 1)
      readPaths.length = 0;
      const beatAlice = recordHeartbeat(rAlice.computer.id, rAlice.nodeToken, { os: "linux" });
      assert.ok(beatAlice);
      assert.equal(beatAlice.userId, "alice");
      assert.ok(readPaths.length > 0);
      assert.ok(readPaths.every((p) => p === userComputersFilePath("alice")));

      // 3. Cold cache / miss refresh test: clear index
      clearComputerIndex(dir);

      readPaths.length = 0;
      // On cold miss, hydrateIndex scans all files, then authenticateComputer resolves Carol
      const authCarol = authenticateComputer(rCarol.computer.id, rCarol.nodeToken);
      assert.ok(authCarol);
      assert.equal(authCarol.userId, "carol");
      // HydrateIndex scanned all files
      assert.ok(readPaths.length > 1);

      // Now index is populated; authenticate for Alice should read ONLY Alice's file
      readPaths.length = 0;
      const authAlice2 = authenticateComputer(rAlice.computer.id, rAlice.nodeToken);
      assert.ok(authAlice2);
      assert.equal(authAlice2.userId, "alice");
      assert.equal(readPaths.length, 1);
      assert.equal(readPaths[0], userComputersFilePath("alice"));

      // And recordHeartbeat for Bob should read ONLY Bob's file
      readPaths.length = 0;
      const beatBob = recordHeartbeat(rBob.computer.id, rBob.nodeToken, { os: "macos" });
      assert.ok(beatBob);
      assert.equal(beatBob.userId, "bob");
      assert.ok(readPaths.length > 0);
      assert.ok(readPaths.every((p) => p === userComputersFilePath("bob")));

      // 4. Stale/Revoked index entry test: if a computer is revoked, authentication fails and does not crash
      assert.equal(revokeComputer("carol", rCarol.computer.id), true);
      assert.equal(authenticateComputer(rCarol.computer.id, rCarol.nodeToken), null);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });
});
