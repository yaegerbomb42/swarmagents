/**
 * Unit tests for lib/browser/cdp-endpoint.ts.
 *
 * Endpoint resolution is exercised with stubbed vmHost/exec/fetchJson, so no
 * VM, socat, or Chromium is needed: the probe-first ordering, the on-demand
 * forwarder start, and the fail-closed cases are all covered here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_IN_VM_MESSAGE,
  CDP_DEBUG_PORT,
  CDP_FORWARD_PORT,
  buildSocatForwarderCommand,
  isValidIpv4,
  resolveBrowserMode,
  resolveCdpEndpointForRun,
  resolveCdpEndpointForUser,
  type CdpEndpointDeps,
} from "./cdp-endpoint";

const VM_IP = "172.18.0.4";
const VERSION_BODY = { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" };

/** Controllable clock: sleep advances it, so probe budgets never wait real time. */
function manualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function stubDeps(overrides: Partial<CdpEndpointDeps> = {}): {
  deps: CdpEndpointDeps;
  calls: { vmHost: string[]; exec: Array<{ userId: string; cmd: string[] }>; fetch: string[] };
} {
  const clock = manualClock();
  const calls = { vmHost: [] as string[], exec: [] as Array<{ userId: string; cmd: string[] }>, fetch: [] as string[] };
  const deps: CdpEndpointDeps = {
    vmHost: async (userId: string) => {
      calls.vmHost.push(userId);
      return VM_IP;
    },
    exec: async (userId: string, cmd: string[]) => {
      calls.exec.push({ userId, cmd });
      return { exitCode: 0 };
    },
    fetchJson: async (url: string) => {
      calls.fetch.push(url);
      return VERSION_BODY;
    },
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
  return { deps, calls };
}

test("resolveBrowserMode: fake driver is unavailable unless SWARM_BROWSER_HOST=1", () => {
  assert.equal(resolveBrowserMode({ NODE_ENV: "test" }), "unavailable");
  assert.equal(resolveBrowserMode({ NODE_ENV: "test", SWARM_BROWSER_HOST: "1" }), "host");
  assert.equal(resolveBrowserMode({ NODE_ENV: "development", SWARM_VM_DRIVER: "fake" }), "unavailable");
  assert.equal(
    resolveBrowserMode({ NODE_ENV: "development", SWARM_VM_DRIVER: "fake", SWARM_BROWSER_HOST: "1" }),
    "host",
  );
});

test("resolveBrowserMode: production defaults to the VM mirror; explicit docker/byoc too", () => {
  assert.equal(resolveBrowserMode({ NODE_ENV: "production" }), "vm");
  assert.equal(resolveBrowserMode({ NODE_ENV: "test", SWARM_VM_DRIVER: "docker" }), "vm");
  assert.equal(resolveBrowserMode({ NODE_ENV: "test", SWARM_VM_DRIVER: "byoc" }), "vm");
  assert.equal(resolveBrowserMode({ NODE_ENV: "test", SWARM_VM_DRIVER: "  docker  " }), "vm");
});

test("isValidIpv4 accepts dotted quads and rejects everything else", () => {
  assert.equal(isValidIpv4("172.18.0.4"), true);
  assert.equal(isValidIpv4("127.0.0.1"), true);
  assert.equal(isValidIpv4("0.0.0.0"), true);
  assert.equal(isValidIpv4("example.com"), false);
  assert.equal(isValidIpv4("172.18.0.4/24"), false);
  assert.equal(isValidIpv4("172.18.0.256"), false);
  assert.equal(isValidIpv4("172.18.0"), false);
  assert.equal(isValidIpv4("172.18.0.4; rm -rf /"), false);
  assert.equal(isValidIpv4(" 172.18.0.4"), false);
  assert.equal(isValidIpv4(""), false);
});

test("buildSocatForwarderCommand forwards 9222 to 9223 on the VM IP, and refuses bad IPs", () => {
  const cmd = buildSocatForwarderCommand(VM_IP);
  assert.ok(cmd);
  assert.equal(cmd[0], "sh");
  assert.equal(cmd[1], "-c");
  const script = cmd[2];
  assert.match(script, /socat TCP-LISTEN:9223,fork,bind=172\.18\.0\.4 TCP:127\.0\.0\.1:9222/);
  assert.match(script, /nohup/);
  // The pkill pattern must use the bracket trick so pkill never matches
  // the shell running this very command.
  assert.match(script, /pkill -f 'socat TCP-LISTEN:922\[3\]'/);
  assert.equal(buildSocatForwarderCommand("example.com"), null);
  assert.equal(buildSocatForwarderCommand("172.18.0.4; id"), null);
  assert.equal(buildSocatForwarderCommand(""), null);
});

test("the CDP ports and the no-browser message are the ones the task specifies", () => {
  assert.equal(CDP_DEBUG_PORT, 9222);
  assert.equal(CDP_FORWARD_PORT, 9223);
  assert.equal(BROWSER_IN_VM_MESSAGE, "Browser runs inside your computer — open the Screen tab");
});

test("resolveCdpEndpointForUser: a healthy probe reuses the forwarder without exec", async () => {
  const { deps, calls } = stubDeps();
  const endpoint = await resolveCdpEndpointForUser("alice", deps);
  assert.deepEqual(endpoint, { url: `http://${VM_IP}:${CDP_FORWARD_PORT}`, vmIp: VM_IP });
  assert.deepEqual(calls.exec, []);
  assert.equal(calls.fetch[0], `http://${VM_IP}:${CDP_FORWARD_PORT}/json/version`);
});

test("resolveCdpEndpointForUser: a dead probe starts the forwarder, then the endpoint answers", async () => {
  let probes = 0;
  const { deps, calls } = stubDeps({
    fetchJson: async (url: string) => {
      calls.fetch.push(url);
      probes += 1;
      if (probes < 3) throw new Error("connection refused");
      return VERSION_BODY;
    },
  });
  const endpoint = await resolveCdpEndpointForUser("alice", deps);
  assert.deepEqual(endpoint, { url: `http://${VM_IP}:${CDP_FORWARD_PORT}`, vmIp: VM_IP });
  assert.equal(calls.exec.length, 1);
  assert.equal(calls.exec[0].userId, "alice");
  assert.equal(calls.exec[0].cmd[0], "sh");
  assert.match(calls.exec[0].cmd[2], /socat TCP-LISTEN:9223/);
});

test("resolveCdpEndpointForUser: no VM (null host) resolves to null without exec or fetch", async () => {
  const { deps, calls } = stubDeps({ vmHost: async () => null });
  assert.equal(await resolveCdpEndpointForUser("alice", deps), null);
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.fetch, []);
});

test("resolveCdpEndpointForUser: a non-IP host fails closed, never reaching a shell", async () => {
  const { deps, calls } = stubDeps({ vmHost: async () => "vm-alice.internal" });
  assert.equal(await resolveCdpEndpointForUser("alice", deps), null);
  assert.deepEqual(calls.exec, []);
});

test("resolveCdpEndpointForUser: a failed forwarder start still returns null when the probe never answers", async () => {
  const { deps, calls } = stubDeps({
    fetchJson: async () => {
      throw new Error("connection refused");
    },
    exec: async (userId: string, cmd: string[]) => {
      calls.exec.push({ userId, cmd });
      return { exitCode: 1 };
    },
  });
  assert.equal(await resolveCdpEndpointForUser("alice", deps), null);
  assert.equal(calls.exec.length, 1, "the start was attempted once");
});

test("resolveCdpEndpointForUser: a probe without webSocketDebuggerUrl does not count as alive", async () => {
  const { deps } = stubDeps({
    fetchJson: async () => ({ Browser: "Chromium" }),
    exec: async () => ({ exitCode: 0 }),
  });
  assert.equal(await resolveCdpEndpointForUser("alice", deps), null);
});

test("resolveCdpEndpointForRun: an unknown run has no owner and resolves to null", async () => {
  const { deps, calls } = stubDeps();
  assert.equal(await resolveCdpEndpointForRun("run_does_not_exist", deps), null);
  assert.deepEqual(calls.vmHost, []);
});
