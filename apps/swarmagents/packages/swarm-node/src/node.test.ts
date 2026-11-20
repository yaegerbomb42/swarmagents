/**
 * Tests for the runner itself.
 *
 * The important one is the host-mode rule: a node that was not started with
 * --host-mode refuses to run anything on the machine, no matter what the
 * server asks for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ByocHub } from "../../../lib/byoc/hub";
import { ByocTokenStore } from "../../../lib/byoc/tokens";
import { SwarmNode } from "./node";
import { loadCredentials } from "./credentials";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-node-test-"));
}

async function startHub(): Promise<{
  hub: ByocHub;
  store: ByocTokenStore;
  url: string;
}> {
  const dir = tempDir();
  const store = new ByocTokenStore({ file: path.join(dir, "byoc.json") });
  const hub = new ByocHub({ port: 0, tokens: store, heartbeatMs: 60_000 });
  await hub.listen();
  return { hub, store, url: `ws://127.0.0.1:${hub.port}/byoc/ws` };
}

/** Wait until a condition holds (or fail). */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("node: a node without --host-mode refuses to run anything on the host", async (t) => {
  const { hub, store, url } = await startHub();
  t.after(() => hub.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const { code } = store.createPairingCode("alice");
  const node = new SwarmNode({
    server: url,
    pairingCode: code,
    name: "no-host-mode",
    hostMode: false,
    credentialsFile: path.join(home, "credentials.json"),
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  await waitFor(() => hub.deviceForUser("alice") !== null);
  const deviceId = hub.deviceForUser("alice") as string;

  // The server asks for a command on the machine itself.
  await assert.rejects(
    () => hub.dispatch(deviceId, "hostExec", { userId: "alice", cmd: ["echo", "pwned"] }),
    /host mode/i,
  );

  // The node is still healthy and serves ordinary commands.
  const result = await hub.dispatch(deviceId, "status", { userId: "alice" });
  assert.ok(result);
});

test("node: a node started with --host-mode runs the command on the machine", async (t) => {
  const { hub, store, url } = await startHub();
  t.after(() => hub.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const { code } = store.createPairingCode("alice");
  const node = new SwarmNode({
    server: url,
    pairingCode: code,
    name: "host-mode",
    hostMode: true,
    credentialsFile: path.join(home, "credentials.json"),
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  await waitFor(() => hub.deviceForUser("alice") !== null);
  const deviceId = hub.deviceForUser("alice") as string;

  const result = (await hub.dispatch(deviceId, "hostExec", {
    userId: "alice",
    cmd: ["sh", "-c", "echo host-mode-ok"],
  })) as { exitCode: number };
  assert.equal(result.exitCode, 0);
});

test("node: pairing stores the device token locally", async (t) => {
  const { hub, store, url } = await startHub();
  t.after(() => hub.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;
  const credentialsFile = path.join(home, "credentials.json");

  const { code } = store.createPairingCode("alice");
  const node = new SwarmNode({
    server: url,
    pairingCode: code,
    name: "pairing-node",
    credentialsFile,
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  await waitFor(() => hub.deviceForUser("alice") !== null);
  await waitFor(() => loadCredentials(credentialsFile) !== null);

  const credentials = loadCredentials(credentialsFile);
  assert.ok(credentials);
  assert.ok(credentials.token.length > 20);
  assert.equal(credentials.server, url);
  // The file is owner-only: the token is a bearer credential.
  const mode = fs.statSync(credentialsFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("node: a revoked device stops the runner", async (t) => {
  const { hub, store, url } = await startHub();
  t.after(() => hub.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const { code } = store.createPairingCode("alice");
  const node = new SwarmNode({
    server: url,
    pairingCode: code,
    name: "revoked-node",
    credentialsFile: path.join(home, "credentials.json"),
    log: () => undefined,
  });
  t.after(() => node.stop());

  let revoked = false;
  node.on("revoked", () => {
    revoked = true;
  });

  void node.start();
  await waitFor(() => hub.deviceForUser("alice") !== null);
  const deviceId = hub.deviceForUser("alice") as string;

  hub.revokeDevice("alice", deviceId, "test");
  await waitFor(() => revoked);
  assert.equal(hub.sessionForDevice(deviceId), null);
});
