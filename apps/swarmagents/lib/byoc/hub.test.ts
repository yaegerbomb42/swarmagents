/**
 * Tests for the BYOC hub: token authentication, pairing, revocation and
 * command dispatch over the tunnel.
 *
 * The tests speak the real wire protocol over a real socket against a real
 * hub — the same path a `swarm-node` runner takes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ByocHub, ByocNodeOfflineError } from "./hub";
import { ByocTokenStore } from "./tokens";
import { WsClient } from "../../packages/swarm-node/src/ws";
import {
  encodeMessage,
  parseMessage,
  type ByocMessage,
  type ByocNodeInfo,
} from "../../packages/swarm-node/src/protocol";

const NODE_INFO: ByocNodeInfo = {
  name: "test-node",
  platform: "linux",
  arch: "x64",
  version: "0.1.0",
  hostMode: false,
  desktop: false,
  docker: true,
};

interface Harness {
  hub: ByocHub;
  store: ByocTokenStore;
  url: string;
  close: () => Promise<void>;
}

async function startHub(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-byoc-hub-"));
  const store = new ByocTokenStore({ file: path.join(dir, "byoc.json") });
  const hub = new ByocHub({ port: 0, tokens: store, heartbeatMs: 60_000 });
  await hub.listen();
  return {
    hub,
    store,
    url: `ws://127.0.0.1:${hub.port}/byoc/ws`,
    close: () => hub.close(),
  };
}

/** Connect a node and wait for the hello answer. */
async function connectNode(
  url: string,
  token: string,
  node: ByocNodeInfo = NODE_INFO,
): Promise<{ client: WsClient; hello: ByocMessage }> {
  const client = await WsClient.connect(url);
  const hello = await new Promise<ByocMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no hello answer")), 5_000);
    client.on("message", (payload: Buffer) => {
      const message = parseMessage(payload.toString("utf8"));
      if (!message) return;
      if (message.t === "hello.ok" || message.t === "hello.error") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    client.sendText(encodeMessage({ t: "hello", token, node }));
  });
  return { client, hello };
}

test("hub: a node with an unknown token is refused", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { client, hello } = await connectNode(harness.url, "totally-bogus-token");
  t.after(() => client.close());
  assert.equal(hello.t, "hello.error");
  if (hello.t !== "hello.error") return;
  assert.equal(hello.code, "unauthorized");
  assert.equal(harness.hub.listSessions().length, 0);
});

test("hub: a pairing code pairs the node and issues a device token", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const first = await connectNode(harness.url, code);
  t.after(() => first.client.close());

  assert.equal(first.hello.t, "hello.ok");
  if (first.hello.t !== "hello.ok") return;
  assert.ok(first.hello.token, "a pairing must hand out a device token");
  assert.equal(harness.hub.listSessions().length, 1);
  assert.equal(harness.hub.deviceForUser("alice"), first.hello.deviceId);

  // The issued token authenticates on the next connection.
  first.client.close();
  const second = await connectNode(harness.url, first.hello.token);
  t.after(() => second.client.close());
  assert.equal(second.hello.t, "hello.ok");
  if (second.hello.t !== "hello.ok") return;
  assert.equal(second.hello.deviceId, first.hello.deviceId);
});

test("hub: revoking a device kills its live session", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  t.after(() => client.close());
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;
  const deviceId = hello.deviceId;

  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  const revoked = harness.hub.revokeDevice("alice", deviceId, "test");
  assert.equal(revoked, true);

  await closed;
  assert.equal(harness.hub.sessionForDevice(deviceId), null);
  assert.equal(harness.hub.deviceForUser("alice"), null);

  // The token is dead too: the node cannot come back.
  const back = await connectNode(harness.url, hello.token ?? "");
  t.after(() => back.client.close());
  assert.equal(back.hello.t, "hello.error");
  if (back.hello.t !== "hello.error") return;
  assert.equal(back.hello.code, "unauthorized");
});

test("hub: a revoked device cannot be revoked by another account", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  t.after(() => client.close());
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;

  assert.equal(harness.hub.revokeDevice("bob", hello.deviceId), false);
  assert.ok(harness.hub.sessionForDevice(hello.deviceId), "the session survives a foreign revoke");
});

test("hub: commands are dispatched to the node and its output is streamed back", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  t.after(() => client.close());
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;
  const deviceId = hello.deviceId;

  client.on("message", (payload: Buffer) => {
    const message = parseMessage(payload.toString("utf8"));
    if (!message || message.t !== "cmd") return;
    client.sendText(
      encodeMessage({
        t: "cmd.out",
        id: message.id,
        stream: "stdout",
        data: Buffer.from("hello from the node", "utf8").toString("base64"),
      }),
    );
    client.sendText(
      encodeMessage({ t: "cmd.result", id: message.id, ok: true, result: { exitCode: 0 } }),
    );
  });

  const chunks: string[] = [];
  const result = await harness.hub.dispatch(
    deviceId,
    "exec",
    { userId: "alice", cmd: ["echo", "hi"] },
    { onStdout: (chunk) => chunks.push(chunk) },
  );
  assert.deepEqual(result, { exitCode: 0 });
  assert.deepEqual(chunks, ["hello from the node"]);
});

test("hub: a failing command rejects with the node's reason", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  t.after(() => client.close());
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;

  client.on("message", (payload: Buffer) => {
    const message = parseMessage(payload.toString("utf8"));
    if (!message || message.t !== "cmd") return;
    client.sendText(
      encodeMessage({ t: "cmd.result", id: message.id, ok: false, error: "boom" }),
    );
  });

  await assert.rejects(
    () => harness.hub.dispatch(hello.deviceId, "exec", { userId: "alice", cmd: ["false"] }),
    /boom/,
  );
});

test("hub: dispatching to an offline device fails fast", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());
  await assert.rejects(
    () => harness.hub.dispatch("dev_missing", "status", { userId: "alice" }),
    (err: unknown) => err instanceof ByocNodeOfflineError,
  );
});

test("hub: a command that is in flight fails when the node drops", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;

  const pending = harness.hub.dispatch(hello.deviceId, "exec", {
    userId: "alice",
    cmd: ["sleep", "60"],
  });
  client.close();
  await assert.rejects(() => pending, /disconnected/i);
});

test("hub: waitForDevice resolves when the node comes back", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;
  const deviceId = hello.deviceId;
  client.close();

  const waiting = harness.hub.waitForDevice(deviceId, 5_000);
  const again = await connectNode(harness.url, hello.token ?? "");
  t.after(() => again.client.close());
  assert.equal(await waiting, true);
});

test("hub: nodes of another account are never routed to", async (t) => {
  const harness = await startHub();
  t.after(() => harness.close());

  const { code } = harness.store.createPairingCode("alice");
  const { client, hello } = await connectNode(harness.url, code);
  t.after(() => client.close());
  assert.equal(hello.t, "hello.ok");
  if (hello.t !== "hello.ok") return;

  assert.equal(harness.hub.deviceForUser("bob"), null);
  assert.equal(harness.hub.hasOnlineNode("bob"), false);
  assert.equal(harness.hub.hasOnlineNode("alice"), true);
});
