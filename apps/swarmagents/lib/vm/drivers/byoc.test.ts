/**
 * Tests for the BYOC VM driver.
 *
 * The driver is the app-side half of the tunnel: it maps the VmDriver
 * contract (ensure / exec / files / snapshots / desktop) onto the commands
 * the server sends to a paired node. The tests run against a real hub and a
 * fake node that speaks the wire protocol.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ByocHub, ByocNodeOfflineError } from "../../byoc/hub";
import { ByocTokenStore } from "../../byoc/tokens";
import { ByocVmDriver } from "./byoc";
import { WsClient } from "../../../packages/swarm-node/src/ws";
import {
  encodeMessage,
  parseMessage,
  type ByocCommand,
  type ByocNodeInfo,
} from "../../../packages/swarm-node/src/protocol";
import type { VmHandle } from "../types";

const NODE_INFO: ByocNodeInfo = {
  name: "driver-node",
  platform: "linux",
  arch: "x64",
  version: "0.1.0",
  hostMode: false,
  desktop: true,
  docker: true,
};

interface FakeNode {
  client: WsClient;
  deviceId: string;
  token: string;
  /** Every command the server sent. */
  received: ByocCommand[];
  close: () => void;
}

async function startPair(
  hub: ByocHub,
  store: ByocTokenStore,
  userId: string,
  node: ByocNodeInfo = NODE_INFO,
  existingToken?: string,
): Promise<FakeNode> {
  const { code } = existingToken
    ? { code: existingToken }
    : store.createPairingCode(userId);
  const client = await WsClient.connect(`ws://127.0.0.1:${hub.port}/byoc/ws`);
  const received: ByocCommand[] = [];
  const hello = await new Promise<{ deviceId: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no hello answer")), 5_000);
    client.on("message", (payload: Buffer) => {
      const message = parseMessage(payload.toString("utf8"));
      if (!message) return;
      if (message.t === "hello.ok") {
        clearTimeout(timer);
        resolve({ deviceId: message.deviceId, token: message.token ?? "" });
        return;
      }
      if (message.t === "desktop.open") {
        try {
          client.sendText(
            encodeMessage({ t: "desktop.ready", id: message.id, ok: true }),
          );
        } catch {
          /* the socket went away */
        }
        return;
      }
      if (message.t === "cmd") {
        received.push(message);
        try {
          client.sendText(
            encodeMessage({ t: "cmd.result", id: message.id, ok: true, result: { exitCode: 0 } }),
          );
        } catch {
          /* the socket went away — the hub sees the drop */
        }
      }
    });
    client.sendText(
      encodeMessage({
        t: "hello",
        token: code,
        node,
        ...(node.desktop ? { desktopPassword: "test-vnc-password" } : {}),
      }),
    );
  });
  return { client, deviceId: hello.deviceId, token: hello.token, received, close: () => client.close() };
}

async function harness(): Promise<{ hub: ByocHub; store: ByocTokenStore }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-byoc-driver-"));
  const store = new ByocTokenStore({ file: path.join(dir, "byoc.json") });
  const hub = new ByocHub({ port: 0, tokens: store, heartbeatMs: 60_000 });
  await hub.listen();
  return { hub, store };
}

test("byoc driver: ensure fails when no node is online", async (t) => {
  const { hub } = await harness();
  t.after(() => hub.close());
  const driver = new ByocVmDriver({ hub });
  await assert.rejects(
    () => driver.ensure("alice"),
    (err: unknown) => err instanceof ByocNodeOfflineError,
  );
});

test("byoc driver: ensure and exec run on the paired node", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice");
  t.after(() => node.close());

  const driver = new ByocVmDriver({ hub });
  const handle = await driver.ensure("alice");
  assert.equal(handle.userId, "alice");
  assert.match(handle.containerName, /^byoc-dev_/);

  let stdout = "";
  const result = await driver.exec(handle, ["echo", "hi"], {
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stdout, "");

  const kinds = node.received.map((command) => command.kind);
  assert.deepEqual(kinds, ["ensure", "exec"]);
  const exec = node.received[1];
  assert.deepEqual((exec.payload as { cmd: string[] }).cmd, ["echo", "hi"]);
});

test("byoc driver: the exec output of the node is streamed to the caller", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const { code } = store.createPairingCode("alice");
  const client = await WsClient.connect(`ws://127.0.0.1:${hub.port}/byoc/ws`);

  await new Promise<void>((resolve) => {
    client.on("message", (payload: Buffer) => {
      const message = parseMessage(payload.toString("utf8"));
      if (!message) return;
      if (message.t === "hello.ok") {
        resolve();
        return;
      }
      if (message.t === "cmd") {
        client.sendText(
          encodeMessage({
            t: "cmd.out",
            id: message.id,
            stream: "stdout",
            data: Buffer.from("chunk-1", "utf8").toString("base64"),
          }),
        );
        client.sendText(
          encodeMessage({
            t: "cmd.out",
            id: message.id,
            stream: "stderr",
            data: Buffer.from("warn", "utf8").toString("base64"),
          }),
        );
        client.sendText(
          encodeMessage({ t: "cmd.result", id: message.id, ok: true, result: { exitCode: 3 } }),
        );
      }
    });
    client.sendText(encodeMessage({ t: "hello", token: code, node: NODE_INFO }));
  });
  t.after(() => client.close());

  const driver = new ByocVmDriver({ hub });
  const handle = await driver.ensure("alice");
  let stdout = "";
  let stderr = "";
  const result = await driver.exec(handle, ["false"], {
    onStdout: (chunk) => {
      stdout += chunk;
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(stdout, "chunk-1");
  assert.equal(stderr, "warn");
});

test("byoc driver: file commands are forwarded to the node", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice");
  t.after(() => node.close());

  const driver = new ByocVmDriver({ hub });
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/a.txt", "hello");
  await driver.readFile(handle, "/workspace/a.txt");

  const kinds = node.received.map((command) => command.kind);
  assert.deepEqual(kinds, ["ensure", "writeFile", "readFile"]);
  const write = node.received[1].payload as { path: string; content: string };
  assert.equal(write.path, "/workspace/a.txt");
  assert.equal(write.content, "hello");
});

test("byoc driver: a run resumes after the node reconnects", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice");

  const driver = new ByocVmDriver({ hub, resumeTimeoutMs: 5_000 });
  const handle = await driver.ensure("alice");

  // The node drops while a command is in flight.
  const pending = driver.exec(handle, ["sleep", "1"]);
  node.close();

  // The node comes back with the same token and answers the retried command.
  const again = await startPair(hub, store, "alice", NODE_INFO, node.token);
  t.after(() => again.close());

  const result = await pending;
  assert.equal(result.exitCode, 0);
});

test("byoc driver: the desktop endpoint is null without a desktop", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice", { ...NODE_INFO, desktop: false });
  t.after(() => node.close());

  const driver = new ByocVmDriver({ hub });
  const handle = await driver.ensure("alice");
  assert.equal(await driver.desktopEndpoint(handle), null);
});

test("byoc driver: the desktop endpoint is loopback-only and carries the node password", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice");
  t.after(() => node.close());

  const driver = new ByocVmDriver({ hub });
  t.after(() => driver.closeDesktopEndpoints());
  const handle = await driver.ensure("alice");

  const endpoint = await driver.desktopEndpoint(handle);
  assert.ok(endpoint);
  assert.equal(endpoint?.host, "127.0.0.1");
  assert.ok((endpoint?.port ?? 0) > 0);
  assert.equal(endpoint?.password, "test-vnc-password");
});

test("byoc driver: an already-aborted exec never reaches the node", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice");
  t.after(() => node.close());

  const driver = new ByocVmDriver({ hub });
  const handle = await driver.ensure("alice");

  const controller = new AbortController();
  controller.abort();
  const result = await driver.exec(handle, ["echo", "hi"], { signal: controller.signal });
  assert.equal(result.exitCode, 130);
  // Only the ensure went out; the aborted exec was never dispatched.
  assert.deepEqual(
    node.received.map((command) => command.kind),
    ["ensure"],
  );
});

test("byoc driver: a handle of another account is never routed to this node", async (t) => {
  const { hub, store } = await harness();
  t.after(() => hub.close());
  const node = await startPair(hub, store, "alice");
  t.after(() => node.close());

  const driver = new ByocVmDriver({ hub });
  await driver.ensure("alice");
  await driver.ensure("alice");

  // A crafted handle naming alice's device but claiming to be bob must not
  // reach the tunnel (the node serves alice's sandbox).
  const foreign: VmHandle = {
    userId: "bob",
    containerName: `byoc-${node.deviceId}`,
    createdAt: Date.now(),
  };
  await assert.rejects(
    () => driver.exec(foreign, ["echo", "nope"]),
    (err: unknown) => err instanceof ByocNodeOfflineError,
  );
});
