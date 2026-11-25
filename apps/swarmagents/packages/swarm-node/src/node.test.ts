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
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ByocHub } from "../../../lib/byoc/hub";
import { ByocTokenStore } from "../../../lib/byoc/tokens";
import { OP_TEXT, encodeFrame } from "../../../lib/desktop-proxy/ws";
import { SwarmNode } from "./node";
import { loadCredentials } from "./credentials";
import { acceptKeyFor, decodeFrames } from "./ws";
import { encodeMessage, parseMessage } from "./protocol";
import type {
  NodeBackend,
  NodeDesktop,
  NodeDirEntry,
  NodeFileBytes,
  NodeFileStat,
  NodeRunOptions,
  NodeSnapshot,
} from "./backend";

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

/**
 * A backend whose exec blocks until its abort signal fires, then reports
 * the kill as exit 130. Proves the node actually hands the signal to the
 * backend — without that, cancel and disconnect leave commands running.
 */
class BlockingBackend implements NodeBackend {
  readonly kind = "host" as const;
  execCalls = 0;
  aborted = false;
  signalSeen: AbortSignal | null = null;

  async exec(_userId: string, _cmd: string[], opts: NodeRunOptions = {}): Promise<{ exitCode: number }> {
    this.execCalls++;
    this.signalSeen = opts.signal ?? null;
    if (opts.signal?.aborted) {
      this.aborted = true;
      return { exitCode: 130 };
    }
    await new Promise<void>((resolve) => {
      opts.signal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          resolve();
        },
        { once: true },
      );
    });
    return { exitCode: 130 };
  }

  async ensure(userId: string): Promise<{ containerName: string }> {
    return { containerName: `host-${userId}` };
  }

  async writeFile(): Promise<void> {}

  async readFile(): Promise<string> {
    return "";
  }

  async stat(_userId: string, filePath: string): Promise<NodeFileStat> {
    return { path: filePath, type: "file", size: 0 };
  }

  async listDir(): Promise<NodeDirEntry[]> {
    return [];
  }

  async readFileBytes(): Promise<NodeFileBytes> {
    return { content: Buffer.alloc(0), size: 0, truncated: false };
  }

  async status(): Promise<{ status: string; error?: string }> {
    return { status: "running" };
  }

  async stop(): Promise<void> {}

  async reset(): Promise<void> {}

  async snapshot(_userId: string, label: string): Promise<NodeSnapshot> {
    return { label, createdAt: Date.now() };
  }

  async listSnapshots(): Promise<NodeSnapshot[]> {
    return [];
  }

  async restore(): Promise<void> {}

  async desktop(): Promise<NodeDesktop | null> {
    return null;
  }

  desktopPassword(): string {
    return "";
  }

  async dispose(): Promise<void> {}
}

/**
 * A bare WebSocket server that completes the handshake and then either
 * answers the hello once or stays silent — the shape of a server that is
 * up but wedged, which a node must not wait on forever.
 */
async function startSilentServer(answerHello: boolean): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const server = http.createServer();
  const sockets = new Set<import("node:stream").Duplex>();
  let connections = 0;
  server.on("upgrade", (req, socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const key = req.headers["sec-websocket-key"] ?? "";
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKeyFor(String(key))}\r\n\r\n`,
    );
    if (answerHello) {
      // Answer the hello only once it arrives: the runner attaches its
      // hello listener after the handshake, so an eager hello.ok would be
      // dropped before anyone is listening for it.
      let buffer: Buffer = Buffer.alloc(0);
      let answered = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let frames;
        try {
          const decoded = decodeFrames(buffer);
          frames = decoded.frames;
          buffer = decoded.rest;
        } catch {
          return;
        }
        for (const frame of frames) {
          if (frame.opcode !== OP_TEXT || answered) continue;
          const message = parseMessage(frame.payload.toString("utf8"));
          if (message?.t !== "hello") continue;
          answered = true;
          socket.write(
            encodeFrame(
              OP_TEXT,
              Buffer.from(
                encodeMessage({
                  t: "hello.ok",
                  deviceId: "dev_fake",
                  sessionId: "s1",
                  serverTime: Date.now(),
                  heartbeatMs: 15_000,
                }),
                "utf8",
              ),
            ),
          );
        }
      });
    }
    // Then: silence. No heartbeat acks, no pings, no close.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    port: addr.port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
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

test("node: a command is aborted when the server cancels it", async (t) => {
  const { hub, store, url } = await startHub();
  t.after(() => hub.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const { code } = store.createPairingCode("alice");
  const backend = new BlockingBackend();
  const node = new SwarmNode({
    server: url,
    pairingCode: code,
    name: "cancel-node",
    credentialsFile: path.join(home, "credentials.json"),
    backend,
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  await waitFor(() => hub.deviceForUser("alice") !== null);
  const deviceId = hub.deviceForUser("alice") as string;

  let commandId = "";
  const pending = hub.dispatch(
    deviceId,
    "exec",
    { userId: "alice", cmd: ["sleep", "60"] },
    {
      onStart: (id) => {
        commandId = id;
      },
    },
  );
  await waitFor(() => backend.execCalls > 0);
  assert.ok(commandId, "the server reported the command id");
  assert.ok(backend.signalSeen, "the node handed the backend an abort signal");
  assert.equal(hub.cancel(deviceId, commandId), true);

  const result = (await pending) as { exitCode: number };
  assert.equal(result.exitCode, 130);
  assert.equal(backend.aborted, true);
});

test("node: in-flight commands are aborted when the tunnel drops", async (t) => {
  const { hub, store, url } = await startHub();
  t.after(() => hub.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const { code } = store.createPairingCode("alice");
  const backend = new BlockingBackend();
  const node = new SwarmNode({
    server: url,
    pairingCode: code,
    name: "drop-node",
    credentialsFile: path.join(home, "credentials.json"),
    backend,
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  await waitFor(() => hub.deviceForUser("alice") !== null);
  const deviceId = hub.deviceForUser("alice") as string;

  const pending = hub.dispatch(deviceId, "exec", { userId: "alice", cmd: ["sleep", "60"] });
  // The rejection is asserted below; keep it from surfacing as unhandled
  // while the test waits for the backend to notice the drop.
  pending.catch(() => undefined);
  await waitFor(() => backend.execCalls > 0);

  // Simulate a transient drop: kill the session socket on the hub side.
  const session = hub.sessionForDevice(deviceId);
  assert.ok(session, "the node has a session");
  session.socket.destroy();

  await waitFor(() => backend.aborted, 5_000);
  assert.ok(backend.signalSeen, "the node handed the backend an abort signal");
  await assert.rejects(() => pending, /disconnected/i);
});

test("node: a hello that is never answered times out and the node reconnects", async (t) => {
  const server = await startSilentServer(false);
  t.after(() => server.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const node = new SwarmNode({
    server: `ws://127.0.0.1:${server.port}/byoc/ws`,
    pairingCode: "fake-pairing-code",
    name: "silent-hello-node",
    credentialsFile: path.join(home, "credentials.json"),
    helloTimeoutMs: 200,
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  // Without the timeout the first attempt would hang forever and no second
  // connection would ever arrive.
  await waitFor(() => server.connections() >= 2, 5_000);
});

test("node: silence from the server triggers a reconnect", async (t) => {
  const server = await startSilentServer(true);
  t.after(() => server.close());
  const home = tempDir();
  process.env.SWARM_NODE_HOME = home;

  const node = new SwarmNode({
    server: `ws://127.0.0.1:${server.port}/byoc/ws`,
    pairingCode: "fake-pairing-code",
    name: "silent-server-node",
    credentialsFile: path.join(home, "credentials.json"),
    serverSilenceTimeoutMs: 300,
    log: () => undefined,
  });
  t.after(() => node.stop());

  void node.start();
  // The server answers the hello once and then goes quiet: the watchdog
  // must close the dead socket so the reconnect loop can re-establish it.
  await waitFor(() => server.connections() >= 2, 5_000);
});
