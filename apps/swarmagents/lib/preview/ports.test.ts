import test from "node:test";
import assert from "node:assert/strict";
import { VmManager } from "../vm/manager";
import type { VmDriver } from "../vm/types";
import {
  clearPreviewPortsCache,
  detectListeningPorts,
  isPreviewablePort,
  listeningPorts,
  parseProcNetListening,
  parseSsListening,
} from "./ports";

const SS_SAMPLE = [
  "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
  'tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=20))',
  'tcp LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("python3",pid=44,fd=3))',
  'tcp LISTEN 0 4096 [::]:5173 [::]:* users:(("node",pid=15,fd=21))',
  'tcp LISTEN 0 4096 *:8080 *:* users:(("node",pid=16,fd=22))',
  'tcp ESTAB 0 0 127.0.0.1:3000 127.0.0.1:54321 users:(("node",pid=12,fd=25))',
  'tcp LISTEN 0 4096 0.0.0.0:6080 0.0.0.0:* users:(("Xtigervnc",pid=9,fd=8))',
  'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=7,fd=3))',
  "udp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:*",
].join("\n");

const PROC_NET_SAMPLE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0",
  "   2: 00000000:1F40 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0",
  "   3: 00000000:17C0 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0",
].join("\n");

const PROC_NET6_SAMPLE = [
  "  sl  local_address                         rem_address                          st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12349 1 0000000000000000 100 0 0 10 0",
].join("\n");

test("preview ports: ss parser keeps LISTEN tcp ports, drops the rest", () => {
  // 3000, 8000, 5173, 8080; ESTAB and udp dropped; 6080 (VNC) and 22 (ssh) excluded.
  assert.deepEqual(parseSsListening(SS_SAMPLE), [3000, 5173, 8000, 8080]);
  assert.deepEqual(parseSsListening(""), []);
  assert.deepEqual(parseSsListening("garbage\nmore garbage\n"), []);
});

test("preview ports: /proc/net/tcp parser keeps state 0A only", () => {
  // 0BB8=3000, 1F90=8080, 1F40=8000 is state 01 (not LISTEN), 17C0=6080 excluded.
  assert.deepEqual(parseProcNetListening(PROC_NET_SAMPLE), [3000, 8080]);
  assert.deepEqual(parseProcNetListening(PROC_NET6_SAMPLE), [5173]);
  assert.deepEqual(parseProcNetListening(""), []);
});

test("preview ports: detect prefers ss, falls back to /proc when ss is empty", async () => {
  const withSs = detectListeningPorts(async (cmd, opts) => {
    opts?.onStdout?.(cmd[0] === "ss" ? SS_SAMPLE : PROC_NET_SAMPLE);
    return { exitCode: 0 };
  });
  assert.deepEqual(await withSs, [3000, 5173, 8000, 8080]);

  const withoutSs = detectListeningPorts(async (cmd, opts) => {
    // ss missing: empty stdout, non-zero exit.
    opts?.onStdout?.(cmd[0] === "ss" ? "" : PROC_NET_SAMPLE);
    return { exitCode: cmd[0] === "ss" ? 127 : 0 };
  });
  assert.deepEqual(await withoutSs, [3000, 8080]);

  const nothing = detectListeningPorts(async () => {
    throw new Error("exec failed");
  });
  assert.deepEqual(await nothing, []);
});

/** Minimal driver whose exec replays canned ss//proc output. */
function stubManager(ssOutput: string, procOutput: string, running = true): VmManager {
  const driver = {
    ensure: async (userId: string) => ({ userId, containerName: `vm-${userId}`, createdAt: 0 }),
    exec: async (_handle: unknown, cmd: string[], opts?: { onStdout?: (chunk: string) => void }) => {
      opts?.onStdout?.(cmd[0] === "ss" ? ssOutput : procOutput);
      return { exitCode: 0 };
    },
    status: async () => ({ status: running ? "running" : "missing" }),
    containerIp: async () => "127.0.0.1",
  } as unknown as VmDriver;
  return new VmManager({ customDriver: driver });
}

test("preview ports: listeningPorts caches, respects TTL, and never wakes a stopped VM", async () => {
  clearPreviewPortsCache();
  const manager = stubManager(SS_SAMPLE, PROC_NET_SAMPLE);
  await manager.ensure("alice");

  let now = 1_000;
  const clock = () => now;
  const first = await listeningPorts(manager, "alice", { ttlMs: 30_000, now: clock });
  assert.equal(first.running, true);
  assert.deepEqual(first.ports, [3000, 5173, 8000, 8080]);
  assert.equal(first.cached, false);

  const cached = await listeningPorts(manager, "alice", { ttlMs: 30_000, now: clock });
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.ports, first.ports);

  now += 31_000;
  const refreshed = await listeningPorts(manager, "alice", { ttlMs: 30_000, now: clock });
  assert.equal(refreshed.cached, false);

  const forced = await listeningPorts(manager, "alice", { forceRefresh: true, now: clock });
  assert.equal(forced.cached, false);

  const stopped = stubManager(SS_SAMPLE, PROC_NET_SAMPLE, false);
  await stopped.ensure("bob");
  const missing = await listeningPorts(stopped, "bob", { now: clock });
  assert.deepEqual(missing, { running: false, ports: [], detectedAt: 0, cached: false });
});

test("preview ports: isPreviewablePort only admits detected ports", async () => {
  clearPreviewPortsCache();
  const manager = stubManager(SS_SAMPLE, PROC_NET_SAMPLE);
  await manager.ensure("alice");
  assert.equal(await isPreviewablePort(manager, "alice", 3000), true);
  assert.equal(await isPreviewablePort(manager, "alice", 9999), false);
  assert.equal(await isPreviewablePort(manager, "alice", 6080), false);
  assert.equal(await isPreviewablePort(manager, "alice", 0), false);
});
