/**
 * Wire protocol between the SwarmAgents server and a `swarm-node` runner
 * (bring-your-own-compute).
 *
 * The node dials OUTBOUND to the server over one authenticated WebSocket
 * (no inbound ports, so it works from a laptop behind NAT). Everything —
 * command traffic, terminal output, telemetry and the noVNC desktop stream —
 * is multiplexed over that single socket:
 *
 *   - Control messages are JSON text frames with a `t` discriminator.
 *   - Binary frames carry desktop bytes: a one-byte kind, a four-byte
 *     big-endian channel id and the raw payload (the WebSocket frames of the
 *     container's noVNC client, relayed verbatim).
 *
 * The server never chooses where a command runs. `exec` always runs in the
 * node's own sandbox (a local container by default); `hostExec` is the only
 * message that can touch the host, and the node refuses it unless the human
 * started the node with `--host-mode`.
 */

/** Protocol version negotiated in the hello exchange. */
export const BYOC_PROTOCOL_VERSION = 1;

/** WebSocket path the node connects to (served by the BYOC hub). */
export const BYOC_WS_PATH = "/byoc/ws";

/** Default port of the BYOC hub (internal; a reverse proxy exposes it). */
export const BYOC_DEFAULT_PORT = 3779;

/** How often the server pings a node. */
export const BYOC_HEARTBEAT_MS = 15_000;

/** A node is dropped when it has been silent for this long. */
export const BYOC_HEARTBEAT_TIMEOUT_MS = 45_000;

/** How long a node has to send its hello frame after the upgrade. */
export const BYOC_HELLO_TIMEOUT_MS = 15_000;

/** Binary frame kind: desktop channel bytes. */
export const BYOC_BINARY_DESKTOP = 1;

/** Longest edge a pairing code may have (8 characters + one dash). */
export const BYOC_PAIRING_CODE_MAX_LEN = 16;

/** How long a pairing code stays valid. */
export const BYOC_PAIRING_TTL_MS = 15 * 60 * 1000;

/** What the node tells the server about itself when it says hello. */
export interface ByocNodeInfo {
  /** Human-readable node name (defaults to the hostname). */
  name: string;
  /** process.platform of the node ("linux", "darwin", "win32", ...). */
  platform: string;
  /** process.arch of the node ("x64", "arm64", ...). */
  arch: string;
  /** Version of the swarm-node package. */
  version: string;
  /** True when the human started this node with --host-mode. */
  hostMode: boolean;
  /** True when the node can serve a desktop (noVNC). */
  desktop: boolean;
  /** True when a local docker daemon is usable. */
  docker: boolean;
}

/** Node -> server: authenticate and register. Must be the first frame. */
export interface ByocHello {
  t: "hello";
  /** The per-device token issued when the pairing code was redeemed. */
  token: string;
  node: ByocNodeInfo;
  /**
   * Password of the node's VNC desktop, when it has one. The server injects
   * it into the RFB handshake — the browser never sees it.
   */
  desktopPassword?: string;
}

/** Server -> node: the session is live. */
export interface ByocHelloOk {
  t: "hello.ok";
  /** Server-side id of the paired device. */
  deviceId: string;
  /** Per-connection session id. */
  sessionId: string;
  serverTime: number;
  heartbeatMs: number;
  /**
   * The device token, sent only when the hello redeemed a one-time pairing
   * code. The node stores it and uses it from then on.
   */
  token?: string;
}

/** Why a hello was rejected. */
export type ByocHelloErrorCode = "unauthorized" | "revoked" | "protocol" | "duplicate";

/** Server -> node: the hello was rejected; the socket is closed right after. */
export interface ByocHelloError {
  t: "hello.error";
  code: ByocHelloErrorCode;
  message: string;
}

/** Node -> server: keep-alive. */
export interface ByocHeartbeat {
  t: "heartbeat";
  ts: number;
}

/** Server -> node: keep-alive acknowledgement. */
export interface ByocHeartbeatAck {
  t: "heartbeat.ack";
  ts: number;
}

/** Every command the server may ask a node to run. */
export interface ByocCommandPayloadMap {
  /** Make sure a sandbox exists for the user (idempotent). */
  ensure: { userId: string };
  /** Run a command inside the node's sandbox. */
  exec: {
    userId: string;
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  };
  /** Write a file inside the node's sandbox. */
  writeFile: { userId: string; path: string; content: string };
  /** Read a text file from the node's sandbox. */
  readFile: { userId: string; path: string };
  /** Stat one path. */
  stat: { userId: string; path: string };
  /** List one directory level. */
  listDir: { userId: string; path: string };
  /** Read raw bytes, capped. */
  readFileBytes: { userId: string; path: string; maxBytes: number };
  /** Runtime status of the sandbox. */
  status: { userId: string };
  /** Stop the sandbox (keep the workspace). */
  stop: { userId: string };
  /** Destroy the sandbox and its workspace. */
  reset: { userId: string };
  /** Create a checkpoint. */
  snapshot: { userId: string; label: string };
  /** List checkpoints. */
  listSnapshots: { userId: string };
  /** Restore a checkpoint. */
  restore: { userId: string; label: string };
  /**
   * Run a command directly on the node's host. The node refuses this unless
   * it was started with --host-mode; the server can never grant that.
   */
  hostExec: {
    userId: string;
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  };
}

/** The command kinds (one per payload shape). */
export type ByocCommandKind = keyof ByocCommandPayloadMap;

/** Server -> node: run a command and report back. */
export interface ByocCommand {
  t: "cmd";
  /** Correlation id, unique per session. */
  id: string;
  kind: ByocCommandKind;
  payload: ByocCommandPayloadMap[ByocCommandKind];
}

/** Node -> server: a chunk of stdout/stderr for a running command. */
export interface ByocCommandOutput {
  t: "cmd.out";
  id: string;
  stream: "stdout" | "stderr";
  /** Base64-encoded chunk. */
  data: string;
}

/** Node -> server: the command finished (successfully or not). */
export interface ByocCommandResult {
  t: "cmd.result";
  id: string;
  ok: boolean;
  /** Human-readable failure reason when ok is false. */
  error?: string;
  /** Command-specific result payload (JSON-safe). */
  result?: unknown;
}

/** Server -> node: abort a running command. */
export interface ByocCommandCancel {
  t: "cmd.cancel";
  id: string;
}

/** Server -> node: open the desktop stream of one user's sandbox. */
export interface ByocDesktopOpen {
  t: "desktop.open";
  id: string;
  /** The account whose sandbox desktop to show (the node is multi-tenant). */
  userId: string;
}

/** Node -> server: the desktop stream is (or is not) available. */
export interface ByocDesktopReady {
  t: "desktop.ready";
  id: string;
  ok: boolean;
  error?: string;
}

/** Server -> node: close the desktop stream. */
export interface ByocDesktopClose {
  t: "desktop.close";
  id: string;
}

/** Server -> node: this device was revoked — drop everything and stop. */
export interface ByocRevoked {
  t: "revoked";
  reason: string;
}

/** Any control message on the wire. */
export type ByocServerMessage =
  | ByocHelloOk
  | ByocHelloError
  | ByocHeartbeatAck
  | ByocCommand
  | ByocCommandCancel
  | ByocDesktopOpen
  | ByocDesktopClose
  | ByocRevoked;

/** Any control message a node may send. */
export type ByocClientMessage =
  | ByocHello
  | ByocHeartbeat
  | ByocCommandOutput
  | ByocCommandResult
  | ByocDesktopReady;

/** Any control message in either direction. */
export type ByocMessage = ByocServerMessage | ByocClientMessage;

/** Wrap desktop bytes in the binary frame envelope. */
export function encodeDesktopFrame(channelId: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(5);
  header[0] = BYOC_BINARY_DESKTOP;
  header.writeUInt32BE(channelId >>> 0, 1);
  return Buffer.concat([header, payload]);
}

/** Unwrap a desktop frame; returns null when the buffer is not one. */
export function decodeDesktopFrame(
  buffer: Buffer,
): { channelId: number; payload: Buffer } | null {
  if (buffer.length < 5) return null;
  if (buffer[0] !== BYOC_BINARY_DESKTOP) return null;
  return {
    channelId: buffer.readUInt32BE(1),
    payload: buffer.subarray(5),
  };
}

/** Parse a control message; returns null for malformed input. */
export function parseMessage(raw: string): ByocMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "string") return null;
  return parsed as ByocMessage;
}

/** Serialize a control message. */
export function encodeMessage(message: ByocMessage): string {
  return JSON.stringify(message);
}
