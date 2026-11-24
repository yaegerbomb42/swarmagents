/**
 * End-to-end test for a bring-your-own-compute node.
 *
 * The whole path is exercised in this box:
 *
 *   1. a local BYOC server (the hub) is started on an ephemeral port;
 *   2. a pairing code is created for the account;
 *   3. a real `swarm-node` process is started against that server and pairs;
 *   4. a task is run through the app's VM manager (the byoc driver) and its
 *      output comes back over the tunnel;
 *   5. the desktop is opened through the app's desktop proxy and the RFB
 *      handshake completes — the screen really shows up.
 *
 * The node runs in --host-mode here because the CI box has no usable docker
 * daemon; the container mode is the default for real users and is covered by
 * the unit tests.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ByocHub } from "../lib/byoc/hub";
import { ByocTokenStore } from "../lib/byoc/tokens";
import { ByocVmDriver } from "../lib/vm/drivers/byoc";
import { VmManager } from "../lib/vm/manager";
import { createDesktopProxy } from "../lib/desktop-proxy/proxy";
import {
  decodeFrames,
  encodeClientFrame,
  type WsMessage,
} from "../lib/desktop-proxy/ws";

const APP_ROOT = path.resolve(__dirname, "..");
const TSX = path.join(APP_ROOT, "node_modules", ".bin", "tsx");
const NODE_CLI = path.join(APP_ROOT, "packages", "swarm-node", "src", "cli.ts");

/** Wait until a predicate holds. */
async function waitFor(predicate: () => boolean, timeoutMs = 30_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Free TCP port (used to give the child node a place to talk to). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * A browser-shaped WebSocket client: it speaks the desktop proxy's protocol
 * and performs the RFB handshake a noVNC client performs.
 */
class DesktopClient {
  private readonly socket: net.Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly frames: WsMessage[] = [];
  private readonly waiters: Array<() => void> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
  }

  /** Start reading websocket frames (after the handshake completed). */
  private attachFrames(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      // The proxy is the server here: its frames are never masked.
      const decoded = decodeFrames(this.buffer, false);
      this.buffer = decoded.rest;
      this.frames.push(...decoded.messages);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  static connect(url: string): Promise<DesktopClient> {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: target.hostname, port: Number(target.port) }, () => {
        const key = Buffer.from(Math.random().toString(36).slice(2)).toString("base64").slice(0, 24);
        socket.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let head = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        const status = head.subarray(0, end).toString("utf8").split("\r\n")[0] ?? "";
        if (!status.includes(" 101 ")) {
          reject(new Error(`desktop upgrade refused: ${status}`));
          socket.destroy();
          return;
        }
        const client = new DesktopClient(socket);
        const rest = head.subarray(end + 4);
        client.attachFrames();
        if (rest.length > 0) socket.unshift(rest);
        resolve(client);
      };
      socket.on("data", onData);
      socket.on("error", reject);
    });
  }

  /** Wait for the next binary frame (with a timeout). */
  async nextBinary(timeoutMs = 15_000): Promise<Buffer> {
    const start = Date.now();
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.opcode === 0x2);
      if (index >= 0) {
        const frame = this.frames.splice(index, 1)[0];
        return Buffer.from(frame.payload);
      }
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a desktop frame");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /**
   * Read exactly `n` bytes, accumulating across frames: TCP segmentation is
   * arbitrary, so a single frame is never a whole RFB message.
   */
  private pending = Buffer.alloc(0);
  async readExact(n: number, timeoutMs = 15_000): Promise<Buffer> {
    const start = Date.now();
    while (this.pending.length < n) {
      const frame = await this.nextBinary(Math.max(1_000, timeoutMs - (Date.now() - start)));
      this.pending = Buffer.concat([this.pending, frame]);
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return Buffer.from(out);
  }

  /** Send raw bytes as a masked binary frame (as a browser would). */
  send(payload: Buffer): void {
    this.socket.write(encodeClientFrame(0x2, payload));
  }

  close(): void {
    this.socket.destroy();
  }
}

test("byoc e2e: a node pairs, runs a task and shows its desktop", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-byoc-e2e-"));
  const store = new ByocTokenStore({ file: path.join(stateDir, "byoc.json") });
  const hub = new ByocHub({ port: 0, tokens: store, heartbeatMs: 2000 });
  await hub.listen();
  t.after(() => hub.close());

  // 1. The app hands out a one-time pairing code.
  const { code } = store.createPairingCode("alice");
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // 2. The node starts in the box and pairs with that code.
  const child: ChildProcess = spawn(
    TSX,
    [
      NODE_CLI,
      "--server",
      `ws://127.0.0.1:${hub.port}/byoc/ws`,
      "--pair",
      code,
      "--name",
      "e2e-node",
      "--host-mode",
      "--state",
      path.join(stateDir, "credentials.json"),
    ],
    {
      cwd: APP_ROOT,
      env: { ...process.env, SWARM_NODE_HOME: path.join(stateDir, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let nodeLog = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    nodeLog += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    nodeLog += chunk.toString("utf8");
  });
  t.after(() => {
    child.kill("SIGTERM");
  });

  // 3. The node shows up in the account.
  await waitFor(() => hub.deviceForUser("alice") !== null, 45_000, "the node to pair");
  const deviceId = hub.deviceForUser("alice") as string;
  const session = hub.sessionForDevice(deviceId);
  assert.ok(session, "expected a live session");
  assert.equal(session?.userId, "alice");
  assert.equal(session?.node.name, "e2e-node");
  assert.equal(session?.node.hostMode, true);

  // The device token is stored locally by the node, never in clear on the
  // server side.
  const credentialsFile = path.join(stateDir, "credentials.json");
  await waitFor(() => fs.existsSync(credentialsFile), 20_000, "the node to store its token");
  const credentials = JSON.parse(fs.readFileSync(credentialsFile, "utf8")) as { token: string };
  assert.ok(credentials.token.length > 20);
  assert.ok(!JSON.stringify(store.listDevices("alice")).includes(credentials.token));

  // 4. A task runs on the node through the app's VM manager.
  const driver = new ByocVmDriver({ hub });
  t.after(() => driver.closeDesktopEndpoints());
  const manager = new VmManager({ customDriver: driver });
  const handle = await manager.ensure("alice");
  assert.match(handle.containerName, /^byoc-dev_/);

  let stdout = "";
  const result = await manager.exec("alice", ["sh", "-c", "echo byoc-e2e-ok"], {
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.match(stdout, /byoc-e2e-ok/);

  // 5. The desktop comes up through the app's desktop proxy.
  const proxy = createDesktopProxy({
    port: 0,
    resolveEndpoint: async () => driver.desktopEndpoint(handle),
  });
  await proxy.listen();
  t.after(() => proxy.close());

  const endpoint = await driver.desktopEndpoint(handle);
  assert.ok(endpoint, "expected a desktop endpoint from the node");
  assert.equal(endpoint?.host, "127.0.0.1");


  const client = await DesktopClient.connect(
    `ws://127.0.0.1:${proxy.port}/desktop/ws?mode=view`,
  );
  t.after(() => client.close());

  // The RFB handshake, exactly as the noVNC client performs it. The desktop
  // proxy terminates RFB toward the browser (and injects the VNC password
  // server-side), so the client sees security type None.
  //
  // RFB 3.8 order: the server sends its version first, and only lists its
  // security types after the client answers with its own version — the types
  // are not part of the greeting.
  const greeting = await client.readExact(12);
  assert.equal(greeting.toString("utf8"), "RFB 003.008\n");

  client.send(Buffer.from("RFB 003.008\n", "utf8"));
  const secCount = await client.readExact(1);
  assert.ok(secCount[0] >= 1, "expected at least one security type");
  const securityTypes = await client.readExact(secCount[0]);
  assert.ok(securityTypes.includes(1), "expected security type None (1)");

  client.send(Buffer.from([1])); // security type: None
  const securityResult = await client.readExact(4);
  assert.deepEqual([...securityResult], [0, 0, 0, 0]);

  client.send(Buffer.from([1])); // ClientInit: shared
  const serverInit = await client.readExact(24);
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  assert.ok(width > 0 && height > 0, `expected a real framebuffer, got ${width}x${height}`);
  // ServerInit is a 24-byte fixed prefix plus a variable-length desktop
  // name: consume the name or the next read starts mid-name.
  const nameLen = serverInit.readUInt32BE(20);
  await client.readExact(nameLen);

  // The desktop is live: ask for the screen (like the noVNC client does)
  // and wait for the framebuffer update that comes back through the tunnel.
  const request = Buffer.alloc(10);
  request[0] = 3; // FramebufferUpdateRequest
  request[1] = 0; // incremental
  request.writeUInt16BE(0, 2); // x
  request.writeUInt16BE(0, 4); // y
  request.writeUInt16BE(width, 6); // width
  request.writeUInt16BE(height, 8); // height
  client.send(request);

  const update = await client.readExact(4);
  assert.equal(update[0], 0, "expected a framebuffer update message");
  assert.ok(update.readUInt16BE(2) > 0, "expected at least one updated rectangle");

  assert.ok(nodeLog.length >= 0);
});
