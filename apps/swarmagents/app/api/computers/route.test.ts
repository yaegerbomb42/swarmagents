import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as listComputersRoute, POST as pairingRoute } from "./route";
import { POST as redeemRoute } from "./pair/route";
import { DELETE as revokeRoute, PATCH as renameRoute } from "./[id]/route";
import { POST as nodeRoute } from "./node/route";
import { GET as computeRoute } from "../runtime/compute/route";
import { GET as listTasksRoute, POST as startTaskRoute } from "../runtime/tasks/route";
import {
  configureComputersClock,
  configureComputersStoreDir,
} from "../../../lib/computers/store";
import { resetRemoteRunManagerForTesting } from "../../../lib/computers/remote";
import { configureAuditPath, readAuditEntries } from "../../../lib/audit";

interface TestInit {
  method?: string;
  body?: string;
  headers?: HeadersInit;
}

function request(url: string, init: TestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers,
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function nodeRequest(computerId: string, token: string, body: unknown) {
  return nodeRoute(
    request(
      "/api/computers/node",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, "x-computer-id": computerId },
      },
      null,
    ),
  );
}

async function pair(user = "alice"): Promise<{ id: string; token: string; code: string; install: Record<string, string> }> {
  const created = await pairingRoute(request("/api/computers", { method: "POST", body: "{}" }, user));
  assert.equal(created.status, 200);
  const pairing = (await created.json()) as {
    code: string;
    install: Record<string, string>;
  };
  const redeemed = await redeemRoute(
    request(
      "/api/computers/pair",
      {
        method: "POST",
        body: JSON.stringify({
          code: pairing.code,
          machine: { name: "Studio Mac", os: "darwin", arch: "arm64", cpuCores: 10, memoryMb: 32768, mode: "host" },
        }),
      },
      null,
    ),
  );
  assert.equal(redeemed.status, 200);
  const body = (await redeemed.json()) as { computer: { id: string }; nodeToken: string };
  return { id: body.computer.id, token: body.nodeToken, code: pairing.code, install: pairing.install };
}

test("computers API: pair, list, rename, heartbeat, run and revoke", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-computers-api-"));
  configureComputersStoreDir(dir);
  configureComputersClock(() => 1_000_000);
  resetRemoteRunManagerForTesting();
  try {
    assert.equal((await listComputersRoute(request("/api/computers", {}, null))).status, 401);

    const created = await pairingRoute(request("/api/computers", { method: "POST", body: "{}" }));
    assert.equal(created.status, 200);
    const pairing = (await created.json()) as { code: string; install: { linux: string; macos: string; windows: string } };
    assert.match(pairing.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    for (const command of Object.values(pairing.install)) {
      assert.ok(command.includes(pairing.code));
      assert.ok(command.includes("http://localhost"));
    }

    // Bad code is indistinguishable from an expired one.
    const bad = await redeemRoute(
      request("/api/computers/pair", { method: "POST", body: JSON.stringify({ code: "AAAAA-AAAAA" }) }, null),
    );
    assert.equal(bad.status, 404);

    const paired = await pair();
    const listed = await listComputersRoute(request("/api/computers"));
    const listBody = (await listed.json()) as { computers: Array<{ id: string; online: boolean; name: string }> };
    assert.equal(listBody.computers.length, 1);
    assert.equal(listBody.computers[0].id, paired.id);
    assert.equal(listBody.computers[0].online, true);
    assert.equal(listBody.computers[0].name, "Studio Mac");
    // Another account sees nothing.
    const otherList = (await (await listComputersRoute(request("/api/computers", {}, "bob"))).json()) as {
      computers: unknown[];
    };
    assert.equal(otherList.computers.length, 0);

    const renamed = await renameRoute(
      request(`/api/computers/${paired.id}`, { method: "PATCH", body: JSON.stringify({ name: "Living-room PC" }) }),
      ctx(paired.id),
    );
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { computer: { name: string } }).computer.name, "Living-room PC");
    assert.equal(
      (await renameRoute(request(`/api/computers/${paired.id}`, { method: "PATCH", body: JSON.stringify({ name: "Mine" }) }, "bob"), ctx(paired.id))).status,
      404,
    );

    // Node heartbeats with its token; a bad token is rejected.
    const beat = await nodeRequest(paired.id, paired.token, { action: "heartbeat", machine: { os: "linux", cpuCores: 4 } });
    assert.equal(beat.status, 200);
    assert.equal(
      (await nodeRequest(paired.id, "0".repeat(64), { action: "heartbeat" })).status,
      401,
    );

    // A BYOC run is queued in the remote control plane, not the cloud manager.
    const started = await startTaskRoute(
      request("/api/runtime/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: "Run the suite", computeTarget: `computer:${paired.id}` }),
      }),
    );
    assert.equal(started.status, 202);
    const { runId } = (await started.json()) as { runId: string };
    const tasks = (await (await listTasksRoute(request("/api/runtime/tasks"))).json()) as {
      runs: Array<{ runId: string; compute?: { kind: string; computerId?: string } }>;
    };
    assert.equal(tasks.runs.find((run) => run.runId === runId)?.compute?.kind, "computer");

    const claim = await nodeRequest(paired.id, paired.token, { action: "claim" });
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()) as { job: { runId: string } | null };
    assert.equal(claimed.job?.runId, runId);
    assert.equal((await nodeRequest(paired.id, paired.token, { action: "event", runId, event: { type: "run.finished" } })).status, 409);
    assert.equal((await nodeRequest(paired.id, paired.token, { action: "event", runId, event: { type: "assistant.text", text: "hi" } })).status, 200);
    assert.equal(
      (await nodeRequest(paired.id, paired.token, { action: "complete", runId, result: { status: "finished", text: "done" } })).status,
      200,
    );

    // Revoke removes the record and invalidates the token immediately.
    assert.equal((await revokeRoute(request(`/api/computers/${paired.id}`, { method: "DELETE" }, "bob"), ctx(paired.id))).status, 404);
    assert.equal((await revokeRoute(request(`/api/computers/${paired.id}`, { method: "DELETE" }), ctx(paired.id))).status, 200);
    assert.equal((await nodeRequest(paired.id, paired.token, { action: "claim" })).status, 401);
  } finally {
    resetRemoteRunManagerForTesting();
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("computers API: install origin ignores a spoofed X-Forwarded-Host unless the proxy is trusted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-computers-origin-"));
  configureComputersStoreDir(dir);
  configureComputersClock(() => 1_000_000);
  const prevTrust = process.env.SWARM_TRUST_PROXY;
  const prevAllowed = process.env.SWARM_ALLOWED_HOSTS;
  try {
    // Proxy not trusted: a spoofed forwarded host must not survive.
    delete process.env.SWARM_TRUST_PROXY;
    delete process.env.SWARM_ALLOWED_HOSTS;
    const untrusted = await pairingRoute(
      request("/api/computers", {
        method: "POST",
        body: "{}",
        headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      }),
    );
    assert.equal(untrusted.status, 200);
    const untrustedBody = (await untrusted.json()) as { install: Record<string, string> };
    for (const command of Object.values(untrustedBody.install)) {
      assert.ok(!command.includes("evil.example"), "spoofed host must not reach the install command");
      assert.ok(command.includes("http://localhost"), `expected the direct host, got: ${command}`);
    }

    // Proxy trusted: the rightmost hop is the one the nearest proxy appended.
    process.env.SWARM_TRUST_PROXY = "1";
    const trusted = await pairingRoute(
      request("/api/computers", {
        method: "POST",
        body: "{}",
        headers: { "x-forwarded-host": "evil.example, swarm.example.com", "x-forwarded-proto": "https" },
      }),
    );
    assert.equal(trusted.status, 200);
    const trustedBody = (await trusted.json()) as { install: Record<string, string> };
    for (const command of Object.values(trustedBody.install)) {
      assert.ok(command.includes("https://swarm.example.com"), `expected the trusted hop, got: ${command}`);
      assert.ok(!command.includes("evil.example"));
    }

    // Allowlist configured: a forwarded host not on it falls back to the public origin.
    process.env.SWARM_ALLOWED_HOSTS = "swarm.example.com";
    const blocked = await pairingRoute(
      request("/api/computers", {
        method: "POST",
        body: "{}",
        headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      }),
    );
    assert.equal(blocked.status, 200);
    const blockedBody = (await blocked.json()) as { install: Record<string, string> };
    for (const command of Object.values(blockedBody.install)) {
      assert.ok(command.includes("https://swarmagents.codes"), `expected the fallback origin, got: ${command}`);
      assert.ok(!command.includes("evil.example"));
    }
  } finally {
    if (prevTrust === undefined) delete process.env.SWARM_TRUST_PROXY;
    else process.env.SWARM_TRUST_PROXY = prevTrust;
    if (prevAllowed === undefined) delete process.env.SWARM_ALLOWED_HOSTS;
    else process.env.SWARM_ALLOWED_HOSTS = prevAllowed;
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("computers API: free tier defaults to BYOC when the cloud pool is full", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-compute-api-"));
  configureComputersStoreDir(dir);
  configureComputersClock(() => 1_000_000);
  const previous = process.env.SWARM_CLOUD_POOL_CAPACITY;
  process.env.SWARM_CLOUD_POOL_CAPACITY = "0";
  try {
    const paired = await pair();
    const res = await computeRoute(request("/api/runtime/compute"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      computers: Array<{ id: string }>;
      cloud: { full: boolean };
      freeTier: boolean;
      defaultTarget: string;
      defaultLabel: string;
    };
    assert.equal(body.cloud.full, true);
    assert.equal(body.freeTier, true);
    assert.equal(body.defaultTarget, `computer:${paired.id}`);
    assert.equal(body.defaultLabel, "Studio Mac");
    assert.equal((await computeRoute(request("/api/runtime/compute", {}, null))).status, 401);
  } finally {
    if (previous === undefined) delete process.env.SWARM_CLOUD_POOL_CAPACITY;
    else process.env.SWARM_CLOUD_POOL_CAPACITY = previous;
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("computers API: pairing and revocation are audit-logged, without token material", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-computers-audit-"));
  configureComputersStoreDir(dir);
  configureComputersClock(() => 1_000_000);
  configureAuditPath(path.join(dir, "audit.jsonl"));
  try {
    const paired = await pair();
    const revoked = await revokeRoute(
      request(`/api/computers/${paired.id}`, { method: "DELETE" }),
      ctx(paired.id),
    );
    assert.equal(revoked.status, 200);

    // readAuditEntries returns newest first.
    const entries = readAuditEntries("alice");
    assert.deepEqual(
      entries.map((entry) => entry.action),
      ["computer.revoke", "computer.pair"],
    );
    assert.ok(entries.every((entry) => entry.target === paired.id));
    assert.ok(entries.every((entry) => entry.result === "success"));
    const logged = entries.map((entry) => JSON.stringify(entry)).join("\n");
    assert.ok(!logged.includes(paired.token), "audit must never carry the node token");
    assert.ok(!logged.includes(paired.code), "audit must never carry the pairing code");
  } finally {
    configureAuditPath(undefined);
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("computers API: requestOrigin multi-hop x-forwarded-proto, fallback allowed hosts, and shell quoting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-computers-origin-"));
  configureComputersStoreDir(dir);
  configureComputersClock(() => 1_000_000);
  const prevTrust = process.env.SWARM_TRUST_PROXY;
  const prevAllowed = process.env.SWARM_ALLOWED_HOSTS;
  try {
    process.env.SWARM_TRUST_PROXY = "1";

    // 1. Multi-hop x-forwarded-proto picks the rightmost hop
    const multiProto = await pairingRoute(
      request("/api/computers", {
        method: "POST",
        body: "{}",
        headers: {
          "x-forwarded-proto": "http, https",
          "x-forwarded-host": "edge.example, origin.example.com",
        },
      }),
    );
    assert.equal(multiProto.status, 200);
    const multiProtoBody = (await multiProto.json()) as { install: { linux: string; macos: string; windows: string } };
    assert.ok(multiProtoBody.install.linux.includes("--server 'https://origin.example.com'"));
    assert.ok(multiProtoBody.install.macos.includes("--server 'https://origin.example.com'"));
    assert.ok(multiProtoBody.install.windows.includes("-Server 'https://origin.example.com'"));

    // 2. IPv6 origin has single quotes around ${origin} in linux & macos install commands
    const ipv6Res = await pairingRoute(
      request("/api/computers", {
        method: "POST",
        body: "{}",
        headers: {
          "x-forwarded-proto": "http",
          "x-forwarded-host": "[::1]:3000",
        },
      }),
    );
    assert.equal(ipv6Res.status, 200);
    const ipv6Body = (await ipv6Res.json()) as { install: { linux: string; macos: string; windows: string } };
    assert.ok(ipv6Body.install.linux.includes("--server 'http://[::1]:3000'"));
    assert.ok(ipv6Body.install.macos.includes("--server 'http://[::1]:3000'"));

    // 3. SWARM_ALLOWED_HOSTS validation also applies to req.nextUrl.origin fallback
    process.env.SWARM_TRUST_PROXY = "0"; // untrusted proxy, candidate fails back to req.nextUrl.origin (localhost)
    process.env.SWARM_ALLOWED_HOSTS = "allowed.domain.com";
    const blockedFallback = await pairingRoute(
      request("/api/computers", {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(blockedFallback.status, 200);
    const blockedFallbackBody = (await blockedFallback.json()) as { install: { linux: string } };
    // localhost is not in allowed.domain.com, so fallback to FALLBACK_ORIGIN
    assert.ok(blockedFallbackBody.install.linux.includes("--server 'https://swarmagents.codes'"));
  } finally {
    if (prevTrust === undefined) delete process.env.SWARM_TRUST_PROXY;
    else process.env.SWARM_TRUST_PROXY = prevTrust;
    if (prevAllowed === undefined) delete process.env.SWARM_ALLOWED_HOSTS;
    else process.env.SWARM_ALLOWED_HOSTS = prevAllowed;
    configureComputersStoreDir("");
    configureComputersClock(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
