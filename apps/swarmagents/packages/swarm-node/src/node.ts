/**
 * The swarm-node runner.
 *
 * The node dials OUTBOUND to the SwarmAgents server, authenticates with its
 * device token (or a one-time pairing code) and then executes the commands
 * the server sends — inside its own Docker container by default, or on the
 * host when the human started it with --host-mode.
 *
 * Everything the server can ask for is implemented here; the server has no
 * way to change where a command runs. The desktop (noVNC) stream is relayed
 * over the very same WebSocket, multiplexed with the command traffic.
 */

import { EventEmitter } from "node:events";
import os from "node:os";
import {
  BYOC_HEARTBEAT_TIMEOUT_MS,
  BYOC_PROTOCOL_VERSION,
  decodeDesktopFrame,
  encodeDesktopFrame,
  encodeMessage,
  parseMessage,
  type ByocClientMessage,
  type ByocCommand,
  type ByocCommandPayloadMap,
  type ByocMessage,
  type ByocNodeInfo,
} from "./protocol";
import { WsClient } from "./ws";
import {
  ContainerBackend,
  HostBackend,
  hasDocker,
  sanitizeUserId,
  type NodeBackend,
} from "./backend";
import { loadCredentials, saveCredentials, defaultCredentialsFile, type NodeCredentials } from "./credentials";

/** Default server the node talks to. */
export const DEFAULT_SERVER_URL = "wss://swarmagents.codes/byoc/ws";

/** Reconnect backoff bounds. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** How long the server has to answer the hello before the node reconnects. */
export const DEFAULT_HELLO_TIMEOUT_MS = 20_000;

/** How often the silence watchdog checks for traffic from the server. */
const SERVER_SILENCE_CHECK_MS = 5_000;

export interface SwarmNodeOptions {
  /** WebSocket URL of the server (ws:// or wss://). */
  server: string;
  /** Device token (used when the node is already paired). */
  token?: string;
  /** One-time pairing code (used for the first connection). */
  pairingCode?: string;
  /** Name shown in the app (default: the hostname). */
  name?: string;
  /** Run commands directly on this machine. */
  hostMode?: boolean;
  /** Container image for the sandbox. */
  image?: string;
  /** Where the device token is cached. */
  credentialsFile?: string;
  /** Log sink (never receives secrets). */
  log?: (message: string) => void;
  /** Backend override (tests). */
  backend?: NodeBackend;
  /** False when the machine cannot offer a desktop at all. */
  desktop?: boolean;
  /**
   * How long the server has to answer the hello before the attempt is
   * abandoned and the node reconnects (default 20s). Without this, a
   * server that accepts the socket but never answers would stall the
   * runner forever: no reconnect, no heartbeat, no error.
   */
  helloTimeoutMs?: number;
  /**
   * Drop and reconnect when the server has sent nothing for this long
   * (default 45s, the hub's heartbeat timeout). The heartbeat is
   * fire-and-forget, so without this a half-open socket — server gone,
   * TCP never closed — would look connected forever.
   */
  serverSilenceTimeoutMs?: number;
}

/** Raised when the server refuses the node's credentials. */
export class NodeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeAuthError";
  }
}

/**
 * The runner.
 *
 * Events: "paired" (device token issued), "connected", "disconnected",
 * "revoked", "error".
 */
export class SwarmNode extends EventEmitter {
  private readonly options: SwarmNodeOptions;
  private readonly log: (message: string) => void;
  private client: WsClient | null = null;
  private backend: NodeBackend | null = null;
  private token: string | undefined;
  private pairingCode: string | undefined;
  /** One upstream noVNC client per desktop channel (several viewers can coexist). */
  private readonly desktopClients = new Map<number, WsClient>();
  private readonly credentialsFile: string;
  private running = false;
  private backoff = MIN_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** When the server last sent anything (drives the silence watchdog). */
  private lastServerMessageAt = 0;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: SwarmNodeOptions) {
    super();
    this.options = options;
    this.log = options.log ?? ((message: string) => console.log(message));
    this.token = options.token;
    this.pairingCode = options.pairingCode;
    this.credentialsFile = options.credentialsFile ?? defaultCredentialsFile();
  }

  /** The device token, once paired. */
  get deviceToken(): string | undefined {
    return this.token;
  }

  /** Start the runner: connect, and keep reconnecting until stopped. */
  async start(): Promise<void> {
    if (!this.token && !this.pairingCode) {
      const stored = loadCredentials(this.credentialsFile);
      if (stored && (!this.options.server || stored.server === this.options.server)) {
        this.token = stored.token;
      }
    }
    this.running = true;
    while (this.running) {
      try {
        await this.connect();
        this.backoff = MIN_BACKOFF_MS;
      } catch (err) {
        if (err instanceof NodeAuthError) {
          this.running = false;
          this.emitError(err);
          throw err;
        }
        this.log(`connection failed: ${(err as Error).message}`);
      }
      if (!this.running) break;
      await this.sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** Stop the runner and release everything. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.abortAllCommands();
    this.closeAllDesktops();
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    if (this.backend) await this.backend.dispose();
    this.backend = null;
  }

  /** Emit "error" without crashing callers that have no listener. */
  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  /**
   * Kill every command that is still running.
   *
   * A command whose socket dropped (or whose server cancelled it) must not
   * keep running orphaned on the node: the hub fails it server-side and the
   * driver retries it after the reconnect, so an orphan would run the same
   * command twice.
   */
  private abortAllCommands(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /** One connection attempt (hello, then serve until the socket drops). */
  private async connect(): Promise<void> {
    const client = await WsClient.connect(this.options.server, { timeoutMs: 20_000 });
    this.client = client;

    const closed = new Promise<void>((resolve) => {
      client.once("close", () => resolve());
    });

    client.on("error", (err: Error) => {
      this.emitError(err);
    });

    client.on("message", (payload: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.handleBinary(payload);
        return;
      }
      const message = parseMessage(payload.toString("utf8"));
      if (!message) return;
      void this.handleMessage(message);
    });

    // The hello answer is awaited before the hello is sent, so a fast server
    // can never answer before the runner is listening for it.
    const readyPromise = this.waitForHello();

    // The hello frame carries either the device token or the one-time
    // pairing code. It is never put in the URL, so it cannot leak into a
    // proxy's access log.
    const hello: ByocClientMessage = {
      t: "hello",
      token: this.token ?? this.pairingCode ?? "",
      node: this.nodeInfo(),
      desktopPassword: await this.desktopPassword(),
    };
    client.sendText(encodeMessage(hello));

    const ready = await readyPromise;
    if (!ready.ok) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      throw ready.error;
    }
    if (ready.token) {
      this.token = ready.token;
      this.pairingCode = undefined;
      const credentials: NodeCredentials = {
        server: this.options.server,
        token: this.token,
        name: this.options.name ?? os.hostname(),
        pairedAt: Date.now(),
      };
      if (this.credentialsFile) saveCredentials(credentials, this.credentialsFile);
      this.emit("paired", { deviceId: ready.deviceId });
    }
    this.emit("connected", { deviceId: ready.deviceId });
    this.lastServerMessageAt = Date.now();
    this.startHeartbeat();

    // The hub pings every 15s and acks our heartbeats, so a live server is
    // never silent for long. A half-open socket produces no traffic at all:
    // close it so the reconnect loop can re-establish the tunnel instead of
    // sitting on a dead connection forever.
    const silenceTimeoutMs =
      this.options.serverSilenceTimeoutMs ?? BYOC_HEARTBEAT_TIMEOUT_MS;
    // Check often enough to notice quickly, but never more than every 5s.
    const checkMs = Math.max(
      50,
      Math.min(SERVER_SILENCE_CHECK_MS, silenceTimeoutMs / 2),
    );
    const silenceTimer = setInterval(() => {
      if (Date.now() - this.lastServerMessageAt > silenceTimeoutMs) {
        this.log("no traffic from the server — reconnecting");
        try {
          client.close();
        } catch {
          /* the socket is already gone */
        }
      }
    }, checkMs);
    silenceTimer.unref?.();

    await closed;
    clearInterval(silenceTimer);
    this.stopHeartbeat();
    this.abortAllCommands();
    this.closeAllDesktops();
    if (this.running) this.emit("disconnected");
  }

  /** What the node tells the server about itself. */
  nodeInfo(): ByocNodeInfo {
    return {
      name: this.options.name ?? os.hostname(),
      platform: process.platform,
      arch: process.arch,
      version: "0.1.0",
      hostMode: this.options.hostMode === true,
      desktop: this.options.desktop !== false,
      docker: hasDocker(),
    };
  }

  /** Wait for the server's hello answer. */
  private waitForHello(): Promise<
    | { ok: true; deviceId: string; token?: string }
    | { ok: false; error: Error }
  > {
    return new Promise((resolve) => {
      const client = this.client;
      if (!client) {
        resolve({ ok: false, error: new Error("No connection.") });
        return;
      }
      const timeoutMs = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
      const timer = setTimeout(() => {
        cleanup();
        resolve({
          ok: false,
          error: new Error("The server did not answer the hello in time."),
        });
      }, timeoutMs);
      timer.unref?.();
      const onMessage = (payload: Buffer) => {
        const message = parseMessage(payload.toString("utf8"));
        if (!message) return;
        if (message.t === "hello.ok") {
          cleanup();
          const token = (message as { token?: string }).token;
          resolve({ ok: true, deviceId: message.deviceId, token });
          return;
        }
        if (message.t === "hello.error") {
          cleanup();
          resolve({
            ok: false,
            error: new NodeAuthError(message.message || "The server refused this node."),
          });
        }
      };
      const onClose = () => {
        cleanup();
        resolve({ ok: false, error: new Error("The server closed the connection.") });
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.off("message", onMessage);
        client.off("close", onClose);
      };
      client.on("message", onMessage);
      client.on("close", onClose);
    });
  }

  /** Handle a control message from the server. */
  private async handleMessage(message: ByocMessage): Promise<void> {
    this.lastServerMessageAt = Date.now();
    switch (message.t) {
      case "heartbeat":
        this.send({ t: "heartbeat", ts: Date.now() });
        break;
      case "revoked":
        this.log("this device was revoked — stopping");
        this.emit("revoked", message.reason);
        this.running = false;
        await this.stop();
        break;
      case "cmd":
        await this.runCommand(message);
        break;
      case "cmd.cancel": {
        const controller = this.abortControllers.get(message.id);
        controller?.abort();
        break;
      }
      case "desktop.open":
        await this.openDesktop(message.id, message.userId);
        break;
      case "desktop.close": {
        const channel = parseChannelId(message.id);
        if (channel !== null) this.closeDesktop(channel);
        break;
      }
      default:
        break;
    }
  }

  /** Run one command and report the result. */
  private async runCommand(command: ByocCommand): Promise<void> {
    const { id, kind } = command;
    const payload = command.payload as ByocCommandPayloadMap[typeof kind];

    try {
      const result = await this.execute(kind, payload, id);
      this.send({ t: "cmd.result", id, ok: true, result });
    } catch (err) {
      this.send({ t: "cmd.result", id, ok: false, error: (err as Error).message });
    } finally {
      this.abortControllers.delete(id);
    }
  }

  /** Execute one command against the local backend. */
  private async execute(
    kind: ByocCommand["kind"],
    payload: ByocCommandPayloadMap[ByocCommand["kind"]],
    id: string,
  ): Promise<unknown> {
    const backend = await this.ensureBackend();
    const controller = new AbortController();
    this.abortControllers.set(id, controller);
    const userId = (payload as { userId?: string }).userId ?? "";

    switch (kind) {
      case "ensure":
        return backend.ensure(userId);
      case "exec": {
        const p = payload as ByocCommandPayloadMap["exec"];
        const result = await backend.exec(userId, p.cmd, {
          cwd: p.cwd,
          env: p.env,
          stdin: p.stdin,
          timeoutMs: p.timeoutMs,
          signal: controller.signal,
          onStdout: (chunk) => this.sendOutput(id, "stdout", chunk),
          onStderr: (chunk) => this.sendOutput(id, "stderr", chunk),
        });
        return { exitCode: result.exitCode };
      }
      case "hostExec": {
        // The server can ask for this, but only a node that a human started
        // with --host-mode may ever run it.
        if (!this.options.hostMode) {
          throw new Error(
            "Host mode is not enabled on this node. Start it with --host-mode to allow it.",
          );
        }
        const p = payload as ByocCommandPayloadMap["hostExec"];
        const hostBackend = this.hostBackend();
        const result = await hostBackend.exec(userId, p.cmd, {
          cwd: p.cwd,
          env: p.env,
          stdin: p.stdin,
          timeoutMs: p.timeoutMs,
          signal: controller.signal,
          onStdout: (chunk) => this.sendOutput(id, "stdout", chunk),
          onStderr: (chunk) => this.sendOutput(id, "stderr", chunk),
        });
        return { exitCode: result.exitCode };
      }
      case "writeFile": {
        const p = payload as ByocCommandPayloadMap["writeFile"];
        await backend.writeFile(userId, p.path, p.content);
        return null;
      }
      case "readFile": {
        const p = payload as ByocCommandPayloadMap["readFile"];
        return { content: await backend.readFile(userId, p.path) };
      }
      case "stat": {
        const p = payload as ByocCommandPayloadMap["stat"];
        return backend.stat(userId, p.path);
      }
      case "listDir": {
        const p = payload as ByocCommandPayloadMap["listDir"];
        return backend.listDir(userId, p.path);
      }
      case "readFileBytes": {
        const p = payload as ByocCommandPayloadMap["readFileBytes"];
        const bytes = await backend.readFileBytes(userId, p.path, p.maxBytes);
        return {
          content: bytes.content.toString("base64"),
          size: bytes.size,
          truncated: bytes.truncated,
        };
      }
      case "status":
        return backend.status(userId);
      case "stop":
        await backend.stop(userId);
        return null;
      case "reset":
        await backend.reset(userId);
        return null;
      case "snapshot": {
        const p = payload as ByocCommandPayloadMap["snapshot"];
        return backend.snapshot(userId, p.label);
      }
      case "listSnapshots":
        return backend.listSnapshots(userId);
      case "restore": {
        const p = payload as ByocCommandPayloadMap["restore"];
        await backend.restore(userId, p.label);
        return null;
      }
      default:
        throw new Error(`Unknown command: ${kind}`);
    }
  }

  /** The backend that runs ordinary commands. */
  private async ensureBackend(): Promise<NodeBackend> {
    if (this.backend) return this.backend;
    if (this.options.backend) {
      this.backend = this.options.backend;
    } else if (this.options.hostMode) {
      this.backend = new HostBackend();
    } else {
      this.backend = new ContainerBackend({
        image: this.options.image,
        desktopPassword: process.env.SWARM_NODE_VNC_PASSWORD,
      });
    }
    return this.backend;
  }

  /** A backend that always runs on the host (used by hostExec). */
  private hostBackend(): NodeBackend {
    if (this.options.hostMode && this.backend?.kind === "host") return this.backend;
    return new HostBackend();
  }

  /** Password of the node's VNC desktop. */
  private async desktopPassword(): Promise<string> {
    const fromEnv = process.env.SWARM_NODE_VNC_PASSWORD;
    if (fromEnv) return fromEnv;
    const backend = await this.ensureBackend();
    return backend.desktopPassword();
  }

  /** Send a control message; a dropped socket is not an error here. */
  private send(message: ByocClientMessage): void {
    const client = this.client;
    if (!client || !client.isOpen) return;
    try {
      client.sendText(encodeMessage(message));
    } catch {
      /* the tunnel dropped — the reconnect loop takes over */
    }
  }

  /** Stream a chunk of command output to the server. */
  private sendOutput(id: string, stream: "stdout" | "stderr", chunk: string): void {
    this.send({
      t: "cmd.out",
      id,
      stream,
      data: Buffer.from(chunk, "utf8").toString("base64"),
    });
  }

  /** Start a desktop stream: connect to the local noVNC client for a channel. */
  private async openDesktop(channelId: string, userId: string): Promise<void> {
    if (!this.client) return;
    const channel = parseChannelId(channelId);
    if (channel === null) {
      this.send({ t: "desktop.ready", id: channelId, ok: false, error: "Bad desktop channel." });
      return;
    }
    this.closeDesktop(channel);
    try {
      const backend = await this.ensureBackend();
      const desktop = await backend.desktop(userId);
      if (!desktop) {
        this.send({
          t: "desktop.ready",
          id: channelId,
          ok: false,
          error: "This node has no desktop.",
        });
        return;
      }
      const upstream = await connectWithRetry(desktop.url, 3);
      this.desktopClients.set(channel, upstream);
      upstream.on("message", (payload: Buffer) => {
        const client = this.client;
        if (!client || !client.isOpen) return;
        try {
          client.sendBinary(encodeDesktopFrame(channel, payload));
        } catch {
          /* the tunnel dropped */
        }
      });
      upstream.on("error", () => {
        /* the desktop channel simply ends */
      });
      upstream.on("close", () => {
        if (this.desktopClients.get(channel) === upstream) {
          this.desktopClients.delete(channel);
        }
      });
      this.send({ t: "desktop.ready", id: channelId, ok: true });
    } catch (err) {
      this.send({
        t: "desktop.ready",
        id: channelId,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  /** Close one desktop stream (or every stream when no channel is given). */
  private closeDesktop(channel?: number): void {
    if (channel === undefined) {
      this.closeAllDesktops();
      return;
    }
    const client = this.desktopClients.get(channel);
    if (!client) return;
    this.desktopClients.delete(channel);
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }

  /** Close every desktop stream (session teardown). */
  private closeAllDesktops(): void {
    for (const client of this.desktopClients.values()) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    this.desktopClients.clear();
  }

  /** Relay desktop bytes coming from the server down to the noVNC client. */
  private handleBinary(payload: Buffer): void {
    this.lastServerMessageAt = Date.now();
    const frame = decodeDesktopFrame(payload);
    if (!frame) return;
    const client = this.desktopClients.get(frame.channelId);
    if (!client) return;
    try {
      client.sendBinary(frame.payload);
    } catch {
      /* the desktop channel is gone */
    }
  }

  /** Keep-alive towards the server. */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.send({ t: "heartbeat", ts: Date.now() });
    }, 10_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

/**
 * Connect to the local desktop, retrying a few times: the noVNC client may
 * still be coming up when the server asks for the desktop.
 */
async function connectWithRetry(url: string, attempts: number): Promise<WsClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      return await WsClient.connect(url, { timeoutMs: 15_000 });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not reach the desktop.");
}

/** Protocol version this runner speaks. */
export const NODE_PROTOCOL_VERSION = BYOC_PROTOCOL_VERSION;

/** Parse a desktop channel id ("d12") into its number (null when malformed). */
function parseChannelId(id: string): number | null {
  const match = /^d(\d{1,10})$/.exec(id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Name a node gets by default. */
export function defaultNodeName(): string {
  return sanitizeUserId(os.hostname()) || "swarm-node";
}
