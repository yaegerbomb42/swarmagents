/**
 * BYOC hub — the server side of the bring-your-own-compute tunnel.
 *
 * A `swarm-node` runner dials OUTBOUND to this server over one WebSocket
 * (default path /byoc/ws, served by a small Node HTTP server that runs in
 * the app process). No inbound port is ever opened on the user's machine,
 * so a node behind NAT works unchanged.
 *
 * What the hub does:
 *   - authenticates the node with its per-device token (the token is only
 *     ever seen in the hello frame, never in a URL, so it cannot leak into
 *     proxy logs);
 *   - keeps one session per paired device, with a heartbeat that drops
 *     silent nodes;
 *   - dispatches commands (exec / files / snapshots) to the node and streams
 *     stdout/stderr back;
 *   - multiplexes the noVNC desktop stream over the very same socket;
 *   - kills the live session the moment a device is revoked.
 *
 * The hub never tells a node to run something outside its sandbox: the
 * execution context is a local decision of the node (see hostExec in the
 * protocol, which the node refuses unless --host-mode was set locally).
 */

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { URL } from "node:url";
import {
  WsFrameDecoder,
  encodeFrame,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
  OP_TEXT,
} from "../desktop-proxy/ws";
import {
  BYOC_DEFAULT_PORT,
  BYOC_HEARTBEAT_MS,
  BYOC_HEARTBEAT_TIMEOUT_MS,
  BYOC_HELLO_TIMEOUT_MS,
  BYOC_PROTOCOL_VERSION,
  BYOC_WS_PATH,
  decodeDesktopFrame,
  encodeDesktopFrame,
  encodeMessage,
  parseMessage,
  type ByocCommand,
  type ByocCommandKind,
  type ByocCommandPayloadMap,
  type ByocHelloErrorCode,
  type ByocMessage,
  type ByocNodeInfo,
} from "../../packages/swarm-node/src/protocol";
import { getByocTokenStore, type ByocDeviceRecord, type ByocTokenStore } from "./tokens";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Base class for every BYOC failure the app surfaces. */
export class ByocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByocError";
  }
}

/** No online node for this account (never paired, or offline). */
export class ByocNodeOfflineError extends ByocError {
  constructor(message = "No BYOC node is online for this account.") {
    super(message);
    this.name = "ByocNodeOfflineError";
  }
}

/** The node dropped while a command was in flight. */
export class ByocNodeDisconnectedError extends ByocError {
  constructor(message = "The BYOC node disconnected during the command.") {
    super(message);
    this.name = "ByocNodeDisconnectedError";
  }
}

/** The node ran the command and reported a failure. */
export class ByocCommandFailedError extends ByocError {
  constructor(message: string) {
    super(message);
    this.name = "ByocCommandFailedError";
  }
}

/** Streaming callbacks for a dispatched command. */
export interface ByocCommandHandlers {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Called with the command id as soon as the command is sent. */
  onStart?: (commandId: string) => void;
}

/** One live desktop stream multiplexed over a node's socket. */
export class ByocDesktopChannel extends EventEmitter {
  readonly id: string;
  readonly channelId: number;
  readonly deviceId: string;
  readonly userId: string;
  private closed = false;

  constructor(id: string, channelId: number, deviceId: string, userId: string) {
    super();
    this.id = id;
    this.channelId = channelId;
    this.deviceId = deviceId;
    this.userId = userId;
  }

  /** Raw bytes travelling node -> browser. */
  deliver(payload: Buffer): void {
    if (this.closed) return;
    this.emit("data", payload);
  }

  /** Mark the channel as finished. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
    this.removeAllListeners();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** A connected node. */
export interface ByocSession {
  /** Per-connection id. */
  id: string;
  deviceId: string;
  userId: string;
  node: ByocNodeInfo;
  socket: net.Socket;
  connectedAt: number;
  lastSeenAt: number;
  /** The VNC password of the node's desktop (never logged). */
  desktopPassword?: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  handlers?: ByocCommandHandlers;
}

export interface ByocHubOptions {
  /** Port to listen on (0 = ephemeral, used by tests). */
  port?: number;
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** Token store (defaults to the process-wide one). */
  tokens?: ByocTokenStore;
  /** Injectable clock. */
  now?: () => number;
  /** Heartbeat interval. */
  heartbeatMs?: number;
  /** Drop a node after this much silence. */
  heartbeatTimeoutMs?: number;
  /** A node must send its hello within this window. */
  helloTimeoutMs?: number;
}

interface DeviceWaiter {
  resolve: (found: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * The hub: node sessions, command dispatch and desktop channels.
 */
export class ByocHub {
  readonly server: http.Server;
  readonly host: string;
  private readonly tokens: ByocTokenStore;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly sessions = new Map<string, ByocSession>();
  private readonly pending = new Map<string, PendingCommand>();
  /** Which session each in-flight command belongs to (reconnect-safe). */
  private readonly pendingSession = new Map<string, string>();
  private readonly waiters = new Map<string, Set<DeviceWaiter>>();
  private readonly desktopChannels = new Map<number, ByocDesktopChannel>();
  private boundPort: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private nextCommandId = 1;
  private nextChannelId = 1;
  private nextSessionId = 1;

  constructor(opts: ByocHubOptions = {}) {
    this.host = opts.host ?? process.env.SWARM_BYOC_HOST ?? "127.0.0.1";
    const rawPort = opts.port ?? Number(process.env.SWARM_BYOC_PORT ?? BYOC_DEFAULT_PORT);
    const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 0;
    this.boundPort = port;
    this.tokens = opts.tokens ?? getByocTokenStore();
    this.now = opts.now ?? Date.now;
    this.heartbeatMs = opts.heartbeatMs ?? BYOC_HEARTBEAT_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? BYOC_HEARTBEAT_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? BYOC_HELLO_TIMEOUT_MS;
    this.server = http.createServer();
    this.server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket as net.Socket, head).catch(() => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
    });
  }

  /** The port the hub listens on (after listen()). */
  get port(): number {
    return this.boundPort;
  }

  /** Start listening. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.boundPort, this.host, () => {
        this.server.off("error", reject);
        const addr = this.server.address();
        if (addr && typeof addr === "object" && addr.port) this.boundPort = addr.port;
        this.startHeartbeat();
        resolve();
      });
    });
  }

  /** Stop listening and drop every session. */
  close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const channel of [...this.desktopChannels.values()]) {
      channel.close();
    }
    this.desktopChannels.clear();
    for (const session of [...this.sessions.values()]) {
      this.dropSession(session, "hub-closed");
    }
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /** All live sessions. */
  listSessions(): ByocSession[] {
    return [...this.sessions.values()];
  }

  /** The live session of a device (null when offline). */
  sessionForDevice(deviceId: string): ByocSession | null {
    return this.sessions.get(deviceId) ?? null;
  }

  /** Every device of a user that is currently connected. */
  onlineDevices(userId: string): ByocDeviceRecord[] {
    const out: ByocDeviceRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      const device = this.tokens.listDevices(userId).find((d) => d.id === session.deviceId);
      if (device) out.push(device);
    }
    return out;
  }

  /** The device id of an online node for a user (the most recent one). */
  deviceForUser(userId: string): string | null {
    let best: ByocSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.userId !== userId) continue;
      if (!best || session.connectedAt > best.connectedAt) best = session;
    }
    return best?.deviceId ?? null;
  }

  /** True when at least one node of this account is connected. */
  hasOnlineNode(userId: string): boolean {
    return this.deviceForUser(userId) !== null;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Send a command to a device and wait for its result. Rejects with
   * {@link ByocNodeOfflineError} when the device is not connected and with
   * {@link ByocNodeDisconnectedError} when the node drops mid-command.
   */
  async dispatch(
    deviceId: string,
    kind: ByocCommandKind,
    payload: ByocCommandPayloadMap[ByocCommandKind],
    handlers?: ByocCommandHandlers,
  ): Promise<unknown> {
    const session = this.sessions.get(deviceId);
    if (!session) throw new ByocNodeOfflineError();
    return this.dispatchOn(session, kind, payload, handlers);
  }

  private dispatchOn(
    session: ByocSession,
    kind: ByocCommandKind,
    payload: ByocCommandPayloadMap[ByocCommandKind],
    handlers?: ByocCommandHandlers,
  ): Promise<unknown> {
    const id = `c${this.nextCommandId++}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, handlers });
      this.pendingSession.set(id, session.id);
      handlers?.onStart?.(id);
      const message = encodeMessage({
        t: "cmd",
        id,
        kind,
        payload,
      } as unknown as ByocCommand);
      if (!this.sendText(session, message)) {
        this.pending.delete(id);
        this.pendingSession.delete(id);
        reject(new ByocNodeDisconnectedError("The BYOC node is not reachable."));
      }
    });
  }

  /** Ask a node to abort a running command. */
  cancel(deviceId: string, commandId: string): boolean {
    const session = this.sessions.get(deviceId);
    if (!session) return false;
    return this.sendText(session, encodeMessage({ t: "cmd.cancel", id: commandId }));
  }

  /**
   * Wait until a device is connected again (used to resume a run after a
   * reconnect). Resolves false when the timeout passes.
   */
  waitForDevice(deviceId: string, timeoutMs: number): Promise<boolean> {
    if (this.sessions.has(deviceId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter: DeviceWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.get(deviceId)?.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      let set = this.waiters.get(deviceId);
      if (!set) {
        set = new Set();
        this.waiters.set(deviceId, set);
      }
      set.add(waiter);
    });
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  /**
   * Revoke a device and kill its live session. The token stops working for
   * the next connection attempt too.
   */
  revokeDevice(userId: string, deviceId: string, reason = "revoked by user"): boolean {
    const revoked = this.tokens.revokeDevice(userId, deviceId, reason);
    // Only the account that owns the device may kill its session.
    if (!revoked) return false;
    const session = this.sessions.get(deviceId);
    if (session) {
      this.sendText(session, encodeMessage({ t: "revoked", reason }));
      this.dropSession(session, "revoked");
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Desktop channels
  // -------------------------------------------------------------------------

  /**
   * Open a desktop channel on a device. The node answers with a
   * `desktop.ready` frame; the returned promise settles when it does.
   *
   * `userId` is the account whose sandbox desktop is shown; a node can serve
   * several accounts, so it must never guess.
   */
  async openDesktop(deviceId: string, userId: string): Promise<ByocDesktopChannel> {
    const session = this.sessions.get(deviceId);
    if (!session) throw new ByocNodeOfflineError("The BYOC node is offline.");
    if (session.userId !== userId) {
      throw new ByocError("This node does not belong to that account.");
    }
    const channelId = this.nextChannelId++;
    const id = `d${channelId}`;
    const channel = new ByocDesktopChannel(id, channelId, deviceId, userId);

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ByocError("The BYOC node did not open its desktop in time."));
      }, 10_000);
      timer.unref?.();
      channel.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      channel.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.desktopChannels.set(channelId, channel);
    const sent = this.sendText(session, encodeMessage({ t: "desktop.open", id, userId }));
    if (!sent) {
      this.desktopChannels.delete(channelId);
      throw new ByocNodeDisconnectedError("The BYOC node is not reachable.");
    }
    try {
      await ready;
    } catch (err) {
      this.desktopChannels.delete(channelId);
      channel.close();
      throw err;
    }
    return channel;
  }

  /** Send raw bytes to a node's desktop channel (browser -> node). */
  writeDesktop(channelId: number, payload: Buffer): boolean {
    const channel = this.desktopChannels.get(channelId);
    if (!channel || channel.isClosed) return false;
    const session = this.sessions.get(channel.deviceId);
    if (!session) return false;
    return this.sendBinary(session, encodeDesktopFrame(channelId, payload));
  }

  /**
   * Close a desktop channel and tell the node to release its local noVNC
   * connection. Called when the browser side of the stream goes away.
   */
  closeDesktop(channelId: number): void {
    const channel = this.desktopChannels.get(channelId);
    if (!channel) return;
    this.desktopChannels.delete(channelId);
    const session = this.sessions.get(channel.deviceId);
    if (session) {
      this.sendText(session, encodeMessage({ t: "desktop.close", id: channel.id }));
    }
    channel.close();
  }

  // -------------------------------------------------------------------------
  // Upgrade / session handling
  // -------------------------------------------------------------------------

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== BYOC_WS_PATH) {
      this.refuseUpgrade(socket, 404, "Not found.");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      this.refuseUpgrade(socket, 400, "Missing Sec-WebSocket-Key.");
      return;
    }

    socket.setNoDelay(true);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    const decoder = new WsFrameDecoder(4 * 1024 * 1024, true);
    let session: ByocSession | null = null;
    let helloTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = null;
      if (session) this.dropSession(session, "closed");
    };

    const fail = (code: ByocHelloErrorCode, message: string) => {
      if (session) return;
      this.sendRaw(socket, encodeFrame(OP_TEXT, Buffer.from(encodeMessage({ t: "hello.error", code, message }))));
      try {
        socket.end(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
      } catch {
        /* ignore */
      }
    };

    socket.on("data", (chunk: Buffer) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch {
        cleanup();
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      for (const message of messages) {
        if (message.opcode === OP_CLOSE) {
          cleanup();
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        if (message.opcode === OP_PING) {
          this.sendRaw(socket, encodeFrame(OP_PONG, message.payload));
          continue;
        }
        if (message.opcode === OP_PONG) continue;
        if (message.opcode === OP_BINARY) {
          if (session) this.handleBinary(session, message.payload);
          continue;
        }
        if (message.opcode !== OP_TEXT) continue;
        const parsed = parseMessage(message.payload.toString("utf8"));
        if (!parsed) continue;
        if (!session) {
          if (parsed.t !== "hello") {
            fail("protocol", "Expected a hello frame.");
            return;
          }
          const accepted = this.acceptHello(
            socket,
            parsed.token,
            parsed.node,
            parsed.desktopPassword,
          );
          if (!accepted) {
            fail("unauthorized", "This device token is not valid.");
            return;
          }
          session = accepted.session;
          if (helloTimer) clearTimeout(helloTimer);
          helloTimer = null;
          this.sendText(
            session,
            encodeMessage({
              t: "hello.ok",
              deviceId: session.deviceId,
              sessionId: session.id,
              serverTime: this.now(),
              heartbeatMs: this.heartbeatMs,
              ...(accepted.issuedToken ? { token: accepted.issuedToken } : {}),
            }),
          );
          continue;
        }
        this.handleMessage(session, parsed);
      }
    });

    socket.on("error", cleanup);
    socket.on("close", cleanup);

    helloTimer = setTimeout(() => {
      if (session) return;
      fail("protocol", "No hello frame received.");
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }, this.helloTimeoutMs);
    helloTimer.unref?.();

    if (head && head.length > 0) socket.unshift(head);
  }

  /**
   * Validate the hello frame and register the session.
   *
   * The hello may carry either a device token (a node that is already
   * paired) or a one-time pairing code (a node that pairs right now). A
   * pairing code is redeemed here and turned into a device token, which is
   * handed back to the node in the hello.ok frame.
   */
  private acceptHello(
    socket: net.Socket,
    token: string,
    node: ByocNodeInfo | undefined,
    desktopPassword?: string,
  ): { session: ByocSession; issuedToken?: string } | null {
    const verified = this.tokens.verifyToken(token);
    let device: ByocDeviceRecord;
    let issuedToken: string | undefined;
    if (verified.ok) {
      device = verified.device;
    } else {
      // Not a device token: try it as a one-time pairing code.
      const name = node?.name ?? "swarm-node";
      const paired = this.tokens.redeemPairingCode(token, name);
      if (!paired.ok) return null;
      device = paired.device;
      issuedToken = paired.token;
    }
    // A second connection for the same device replaces the old one.
    const existing = this.sessions.get(device.id);
    if (existing) this.dropSession(existing, "replaced");

    const session: ByocSession = {
      id: `s${this.nextSessionId++}`,
      deviceId: device.id,
      userId: device.userId,
      node: node ?? {
        name: device.name,
        platform: "unknown",
        arch: "unknown",
        version: "0",
        hostMode: false,
        desktop: false,
        docker: false,
      },
      socket,
      connectedAt: this.now(),
      lastSeenAt: this.now(),
      desktopPassword,
    };
    this.sessions.set(device.id, session);
    this.tokens.touch(device.id);
    this.resolveWaiters(device.id);

    socket.on("close", () => this.dropSession(session, "closed"));
    socket.on("error", () => this.dropSession(session, "error"));
    return { session, issuedToken };
  }

  private handleMessage(session: ByocSession, message: ByocMessage): void {
    session.lastSeenAt = this.now();
    switch (message.t) {
      case "heartbeat":
        this.sendText(session, encodeMessage({ t: "heartbeat.ack", ts: this.now() }));
        break;
      case "cmd.out": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        const chunk = Buffer.from(message.data ?? "", "base64").toString("utf8");
        if (message.stream === "stderr") pending.handlers?.onStderr?.(chunk);
        else pending.handlers?.onStdout?.(chunk);
        break;
      }
      case "cmd.result": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        this.pendingSession.delete(message.id);
        if (message.ok === true) pending.resolve(message.result);
        else {
          pending.reject(
            new ByocCommandFailedError(String(message.error ?? "The node reported a failure.")),
          );
        }
        break;
      }
      case "desktop.ready": {
        const channelId = Number(message.id.replace(/^d/, ""));
        const channel = this.desktopChannels.get(channelId);
        if (!channel || channel.deviceId !== session.deviceId) return;
        if (message.ok === true) channel.emit("ready");
        else channel.emit("error", new ByocError(String(message.error ?? "The node has no desktop.")));
        break;
      }
      default:
        break;
    }
  }

  private handleBinary(session: ByocSession, payload: Buffer): void {
    const frame = decodeDesktopFrame(payload);
    if (!frame) return;
    const channel = this.desktopChannels.get(frame.channelId);
    if (!channel || channel.deviceId !== session.deviceId) return;
    channel.deliver(frame.payload);
  }

  /** Remove a session and fail everything that was in flight on it. */
  private dropSession(session: ByocSession, reason: string): void {
    if (this.sessions.get(session.deviceId) !== session) return;
    this.sessions.delete(session.deviceId);
    session.lastSeenAt = this.now();

    this.failPendingFor(session, reason);

    for (const [channelId, channel] of [...this.desktopChannels]) {
      if (channel.deviceId !== session.deviceId) continue;
      this.desktopChannels.delete(channelId);
      channel.close();
    }

    try {
      session.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  private failPendingFor(session: ByocSession, reason: string): void {
    // Commands are keyed by a global counter; track them per session so a
    // reconnect only fails the commands that belonged to the dead socket.
    for (const [id, pending] of [...this.pending]) {
      if (this.pendingSession.get(id) !== session.id) continue;
      this.pending.delete(id);
      this.pendingSession.delete(id);
      pending.reject(new ByocNodeDisconnectedError(`The BYOC node disconnected (${reason}).`));
    }
  }

  private resolveWaiters(deviceId: string): void {
    const set = this.waiters.get(deviceId);
    if (!set) return;
    this.waiters.delete(deviceId);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  private sendRaw(socket: net.Socket, data: Buffer): boolean {
    if (socket.destroyed) return false;
    try {
      socket.write(data);
      return true;
    } catch {
      return false;
    }
  }

  private sendText(session: ByocSession, text: string): boolean {
    return this.sendRaw(session.socket, encodeFrame(OP_TEXT, Buffer.from(text, "utf8")));
  }

  private sendBinary(session: ByocSession, payload: Buffer): boolean {
    return this.sendRaw(session.socket, encodeFrame(OP_BINARY, payload));
  }

  private refuseUpgrade(socket: net.Socket, status: number, message: string): void {
    const body = Buffer.from(message, "utf8");
    try {
      socket.write(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
          "Connection: close\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n" +
          `Content-Length: ${body.length}\r\n` +
          "Cache-Control: no-store\r\n\r\n",
      );
      socket.end(body);
    } catch {
      /* ignore */
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = this.now();
      for (const session of [...this.sessions.values()]) {
        if (now - session.lastSeenAt > this.heartbeatTimeoutMs) {
          this.dropSession(session, "heartbeat-timeout");
          continue;
        }
        this.sendText(session, encodeMessage({ t: "heartbeat", ts: now }));
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
}

/** RFC 6455 accept key for a client's Sec-WebSocket-Key. */
export function acceptKey(key: string): string {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** Re-exported for the driver's convenience. */
export { BYOC_PROTOCOL_VERSION };

const g = globalThis as typeof globalThis & { __swarmByocHub?: ByocHub };

/** Process-wide hub used by the driver and the API routes. */
export function getByocHub(): ByocHub {
  if (!g.__swarmByocHub) g.__swarmByocHub = new ByocHub();
  return g.__swarmByocHub;
}

/** Test hook: swap (or clear) the process-wide hub. */
export function setByocHubForTesting(hub: ByocHub | null): void {
  g.__swarmByocHub = hub ?? undefined;
}
