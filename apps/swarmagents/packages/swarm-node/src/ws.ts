/**
 * Minimal RFC 6455 WebSocket client.
 *
 * The runner only needs one thing from the protocol: a masked client that can
 * send text (control messages) and binary frames (desktop bytes) and read the
 * server's frames back. It is deliberately dependency-free so the runner
 * installs with nothing but Node.
 */

import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { URL } from "node:url";

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One decoded frame. */
export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Encode one client->server frame (always masked, per RFC 6455). */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ key[i & 3];
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, key, masked]);
}

/** Decode as many complete frames as the buffer holds. */
export function decodeFrames(input: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let offset = 0;
  let fragments: Buffer[] = [];
  let fragmentOpcode = OP_BINARY;

  for (;;) {
    if (offset + 2 > input.length) break;
    const fin = (input[offset] & 0x80) !== 0;
    const opcode = input[offset] & 0x0f;
    const masked = (input[offset + 1] & 0x80) !== 0;
    let len = input[offset + 1] & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > input.length) break;
      len = input.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > input.length) break;
      const high = input.readUInt32BE(offset + 2);
      const low = input.readUInt32BE(offset + 6);
      if (high !== 0) throw new Error("WebSocket frame too large");
      len = low;
      headerLen = 10;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (offset + headerLen + 4 > input.length) break;
      maskKey = input.subarray(offset + headerLen, offset + headerLen + 4);
      headerLen += 4;
    }
    if (offset + headerLen + len > input.length) break;
    const encoded = input.subarray(offset + headerLen, offset + headerLen + len);
    const payload = maskKey ? unmask(encoded, maskKey) : Buffer.from(encoded);
    offset += headerLen + len;

    if (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) {
      frames.push({ fin: true, opcode, payload });
      continue;
    }
    if (opcode === OP_CONTINUATION) {
      fragments.push(payload);
      if (fin) {
        frames.push({ fin: true, opcode: fragmentOpcode, payload: Buffer.concat(fragments) });
        fragments = [];
      }
      continue;
    }
    if (fin) {
      frames.push({ fin: true, opcode, payload });
    } else {
      fragments = [payload];
      fragmentOpcode = opcode;
    }
  }
  return { frames, rest: input.subarray(offset) };
}

function unmask(payload: Buffer, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}

/** The handshake key the server's accept value is derived from. */
export function acceptKeyFor(key: string): string {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

export interface WsClientOptions {
  /** Extra request headers (never used for secrets). */
  headers?: Record<string, string>;
  /** Connect + handshake timeout in ms. */
  timeoutMs?: number;
}

/**
 * A connected WebSocket client.
 *
 * Events: "open", "message" (payload: Buffer, isBinary: boolean), "close",
 * "error" (Error).
 */
export class WsClient extends EventEmitter {
  private readonly socket: net.Socket | tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = OP_BINARY;
  private closed = false;
  private handshakeDone = false;

  private constructor(socket: net.Socket | tls.TLSSocket) {
    super();
    this.socket = socket;
    this.socket.on("error", (err: Error) => {
      if (!this.closed && this.listenerCount("error") > 0) this.emit("error", err);
      this.finish();
    });
    this.socket.on("close", () => this.finish());
  }

  /** Start reading frames (only after the handshake completed). */
  private attachDataHandler(): void {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  /** Connect to a ws:// or wss:// URL and complete the handshake. */
  static connect(url: string, opts: WsClientOptions = {}): Promise<WsClient> {
    const target = new URL(url);
    if (target.protocol !== "ws:" && target.protocol !== "wss:") {
      return Promise.reject(new Error(`Unsupported WebSocket protocol: ${target.protocol}`));
    }
    const secure = target.protocol === "wss:";
    const port = Number(target.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString("base64");
    const timeoutMs = opts.timeoutMs ?? 20_000;

    return new Promise<WsClient>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const onConnect = () => {
        const requestPath = `${target.pathname || "/"}${target.search || ""}`;
        const headers: string[] = [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${target.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
        ];
        for (const [name, value] of Object.entries(opts.headers ?? {})) {
          headers.push(`${name}: ${value}`);
        }
        socket.write(`${headers.join("\r\n")}\r\n\r\n`);
      };

      const socket = secure
        ? tls.connect({ host: target.hostname, port, servername: target.hostname }, onConnect)
        : net.connect({ host: target.hostname, port }, onConnect);

      const timer = setTimeout(() => {
        fail(new Error("WebSocket handshake timed out"));
        socket.destroy();
      }, timeoutMs);
      timer.unref?.();

      const client = new WsClient(socket);
      socket.on("error", (err: Error) => fail(err));

      let head = Buffer.alloc(0);
      const onHandshakeData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headerText = head.subarray(0, end).toString("utf8");
        const rest = head.subarray(end + 4);
        socket.off("data", onHandshakeData);
        const statusLine = headerText.split("\r\n")[0] ?? "";
        if (!/ 101 /.test(statusLine)) {
          fail(new Error(`WebSocket upgrade refused: ${statusLine.trim()}`));
          socket.destroy();
          return;
        }
        const expected = acceptKeyFor(key);
        if (!headerText.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
          fail(new Error("WebSocket accept key mismatch"));
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        settled = true;
        client.handshakeDone = true;
        client.attachDataHandler();
        client.emit("open");
        if (rest.length > 0) client.onData(rest);
        resolve(client);
      };
      socket.on("data", onHandshakeData);
    });
  }

  /** True when the socket is usable. */
  get isOpen(): boolean {
    return !this.closed && this.handshakeDone;
  }

  /** Send a text frame. */
  sendText(text: string): void {
    this.send(encodeClientFrame(OP_TEXT, Buffer.from(text, "utf8")));
  }

  /** Send a binary frame. */
  sendBinary(payload: Buffer): void {
    this.send(encodeClientFrame(OP_BINARY, payload));
  }

  private send(frame: Buffer): void {
    if (this.closed) throw new Error("WebSocket is closed");
    this.socket.write(frame);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let frames: WsFrame[];
    try {
      const decoded = decodeFrames(this.buffer);
      frames = decoded.frames;
      this.buffer = decoded.rest;
    } catch (err) {
      this.emit("error", err as Error);
      this.close(1002);
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === OP_PING) {
        this.socket.write(encodeClientFrame(OP_PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OP_PONG) continue;
      if (frame.opcode === OP_CLOSE) {
        this.finish();
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (frame.opcode === OP_CONTINUATION) {
        this.fragments.push(frame.payload);
        continue;
      }
      if (!frame.fin) {
        this.fragments = [frame.payload];
        this.fragmentOpcode = frame.opcode;
        continue;
      }
      const payload =
        this.fragments.length > 0
          ? Buffer.concat([...this.fragments, frame.payload])
          : frame.payload;
      this.fragments = [];
      this.emit("message", payload, frame.opcode === OP_BINARY);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  /** Close the socket. */
  close(code = 1000): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0)));
    } catch {
      /* ignore */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.finish();
  }
}
