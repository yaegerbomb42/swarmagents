/**
 * Minimal RFC 6455 WebSocket frame codec for the desktop proxy.
 *
 * The proxy terminates the WebSocket layer at both ends (the browser and the
 * container's VNC web client), so it must decode the masked client frames and
 * encode unmasked server frames. Only binary messages are expected on the RFB
 * pipe; control frames (ping/pong/close) are surfaced so the caller can answer
 * them, and fragmented messages are reassembled.
 */

import crypto from "node:crypto";

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export interface WsMessage {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

/**
 * Default cap on bytes a single direction may hold while reassembling: the
 * unparsed raw receive buffer plus any fragments of an unfinished message.
 * A 1600x900 raw 32bpp framebuffer update is ~5.8 MB, so 32 MB leaves ample
 * headroom while bounding memory per connection.
 */
export const MAX_WS_BUFFER_BYTES = 32 * 1024 * 1024;

/** Thrown when a frame/message would exceed the decoder's buffer cap. */
export class WsBufferOverflowError extends Error {
  constructor(message = "WebSocket message exceeds buffer cap") {
    super(message);
    this.name = "WsBufferOverflowError";
  }
}

/** Thrown when a frame's MASK bit violates the expected direction. */
export class WsMaskError extends Error {
  constructor(message = "WebSocket frame mask violation") {
    super(message);
    this.name = "WsMaskError";
  }
}

interface FrameHeader {
  fin: boolean;
  opcode: number;
  masked: boolean;
  maskKey: Buffer | null;
  len: number;
  headerLen: number;
}

/** Opcodes defined by RFC 6455 §5.2; everything else is reserved. */
const VALID_OPCODES = new Set([
  OP_CONTINUATION,
  OP_TEXT,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
]);

/**
 * Parse one frame header at `offset`. Returns null when the header itself is
 * not complete yet (the payload may still be incomplete when it returns).
 *
 * Throws on protocol violations that must fail the connection (RFC 6455
 * §5.2/§7.1.7): reserved bits set without a negotiated extension, reserved
 * opcodes, and malformed control frames.
 */
function parseFrameHeader(input: Buffer, offset: number): FrameHeader | null {
  if (offset + 2 > input.length) return null;
  const b0 = input[offset];
  const b1 = input[offset + 1];
  const fin = (b0 & 0x80) !== 0;
  // RSV1–RSV3 must be zero unless an extension defining them was negotiated;
  // this codec negotiates none, so any set bit is a protocol error.
  if ((b0 & 0x70) !== 0) throw new Error("Reserved bits set without negotiated extension");
  const opcode = b0 & 0x0f;
  if (!VALID_OPCODES.has(opcode)) throw new Error(`Reserved opcode 0x${opcode.toString(16)}`);
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let headerLen = 2;
  if (len === 126) {
    if (offset + 4 > input.length) return null;
    len = input.readUInt16BE(offset + 2);
    headerLen = 4;
  } else if (len === 127) {
    if (offset + 10 > input.length) return null;
    const high = input.readUInt32BE(offset + 2);
    const low = input.readUInt32BE(offset + 6);
    if (high !== 0 || low > 0x7fffffff) throw new WsBufferOverflowError("WebSocket frame too large");
    len = low;
    headerLen = 10;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (offset + headerLen + 4 > input.length) return null;
    maskKey = input.subarray(offset + headerLen, offset + headerLen + 4);
    headerLen += 4;
  }
  if (opcode >= 0x8 && (len > 125 || !fin)) {
    throw new Error("Invalid control frame");
  }
  return { fin, opcode, masked, maskKey, len, headerLen };
}

/**
 * Decode as many complete frames as possible from a buffer.
 *
 * Stateless: fragmented messages are only reassembled when every fragment is
 * inside `input`. Streams should use {@link WsFrameDecoder}, which keeps the
 * raw remainder and fragment state across calls.
 */
export function decodeFrames(
  input: Buffer,
  expectMasked?: boolean,
): { messages: WsMessage[]; rest: Buffer } {
  const messages: WsMessage[] = [];
  let offset = 0;
  let continuation: Buffer | null = null;
  let continuationOpcode = OP_BINARY;

  for (;;) {
    const h = parseFrameHeader(input, offset);
    if (!h) break;
    const { fin, opcode, masked, maskKey, len, headerLen } = h;
    if (offset + headerLen + len > input.length) break;
    if (expectMasked !== undefined && masked !== expectMasked) {
      throw new WsMaskError();
    }

    const encoded = input.subarray(offset + headerLen, offset + headerLen + len);
    const payload = maskKey ? unmask(encoded, maskKey) : Buffer.from(encoded);
    offset += headerLen + len;

    if (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) {
      // Control frames never fragment.
      messages.push({ opcode, payload, fin: true });
      continue;
    }
    if (opcode === OP_CONTINUATION) {
      if (continuation === null) throw new Error("Unexpected continuation frame");
      continuation = Buffer.concat([continuation, payload]);
      if (fin) {
        messages.push({ opcode: continuationOpcode, payload: continuation, fin: true });
        continuation = null;
      }
      continue;
    }
    // Data frame.
    if (continuation !== null) throw new Error("Interleaved data frame during fragmentation");
    if (fin) {
      messages.push({ opcode, payload, fin: true });
    } else {
      continuation = payload;
      continuationOpcode = opcode;
    }
  }
  return { messages, rest: input.subarray(offset) };
}

/**
 * Streaming WebSocket frame decoder for one direction of a TCP connection.
 *
 * TCP delivers arbitrary slices of the byte stream, so a frame (header and/or
 * payload) routinely spans many `data` events — a 200 KB framebuffer update
 * typically arrives as dozens of chunks. The decoder keeps the unparsed raw
 * bytes and prepends them to the next chunk, and keeps fragmented-message
 * state (FIN=0 + continuation frames) across calls. Control frames may be
 * interleaved between fragments, as RFC 6455 allows.
 *
 * Memory is bounded: if the raw buffer plus pending fragments would exceed
 * `maxBytes` (checked as soon as a frame header declares its length, before
 * the payload is buffered) `push` throws {@link WsBufferOverflowError}.
 */
export class WsFrameDecoder {
  private raw: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;

  constructor(
    private readonly maxBytes: number = MAX_WS_BUFFER_BYTES,
    private readonly expectMasked?: boolean,
  ) {}

  /** Bytes currently held (raw remainder + pending fragments). */
  get bufferedBytes(): number {
    return this.raw.length + this.fragmentBytes;
  }

  /** Feed one chunk; returns every message completed by it, in order. */
  push(chunk: Buffer): WsMessage[] {
    const input = this.raw.length === 0 ? chunk : Buffer.concat([this.raw, chunk]);
    const messages: WsMessage[] = [];
    let offset = 0;

    for (;;) {
      const h = parseFrameHeader(input, offset);
      if (!h) break;
      const { fin, opcode, masked, maskKey, len, headerLen } = h;
      const isControl = opcode >= 0x8;
      // Fail fast on a declared length that can never fit, rather than
      // buffering up to the cap first.
      if (headerLen + len + (isControl ? 0 : this.fragmentBytes) > this.maxBytes) {
        throw new WsBufferOverflowError();
      }
      if (offset + headerLen + len > input.length) break;
      if (this.expectMasked !== undefined && masked !== this.expectMasked) {
        throw new WsMaskError();
      }

      const encoded = input.subarray(offset + headerLen, offset + headerLen + len);
      const payload = maskKey ? unmask(encoded, maskKey) : Buffer.from(encoded);
      offset += headerLen + len;

      if (isControl) {
        messages.push({ opcode, payload, fin: true });
        continue;
      }
      if (opcode === OP_CONTINUATION) {
        if (this.fragmentOpcode === null) throw new Error("Unexpected continuation frame");
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (fin) {
          messages.push({
            opcode: this.fragmentOpcode,
            payload: Buffer.concat(this.fragments, this.fragmentBytes),
            fin: true,
          });
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = null;
        }
        continue;
      }
      if (this.fragmentOpcode !== null) throw new Error("Interleaved data frame during fragmentation");
      if (fin) {
        messages.push({ opcode, payload, fin: true });
      } else {
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        this.fragmentOpcode = opcode;
      }
    }

    const rest = input.subarray(offset);
    // Copy a short remainder so it doesn't pin a large consumed buffer.
    this.raw = rest.length === 0 ? Buffer.alloc(0) : rest.length === input.length ? input : Buffer.from(rest);
    if (this.bufferedBytes > this.maxBytes) throw new WsBufferOverflowError();
    return messages;
  }
}

function unmask(payload: Buffer, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}

/** Encode one server->client frame (never masked). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  return encodeFrameWithMask(opcode, payload, null);
}

/** Encode one client->server frame (always masked, per RFC 6455). */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ key[i & 3];
  return encodeFrameWithMask(opcode, masked, key);
}

function encodeFrameWithMask(opcode: number, payload: Buffer, maskKey: Buffer | null): Buffer {
  // The opcode occupies the low nibble of the first header byte; anything
  // outside 0–15 would silently corrupt the FIN/RSV bits.
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0x0f) {
    throw new Error(`Invalid opcode ${opcode}`);
  }
  const len = payload.length;
  let header: Buffer;
  const maskBit = maskKey ? 0x80 : 0;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, maskKey ?? Buffer.alloc(0), payload]);
}

function closePayload(code: number, reason: string): Buffer {
  // Control-frame payloads are capped at 125 bytes (RFC 6455 §5.5); with the
  // 2-byte status code the reason gets 123. Truncate on a character boundary
  // so an over-long reason yields a valid frame instead of a protocol error
  // at the peer.
  let trimmed = reason;
  while (Buffer.byteLength(trimmed, "utf8") > 123) trimmed = trimmed.slice(0, -1);
  const reasonBuf = Buffer.from(trimmed, "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return payload;
}

/** Build a server->client close frame with a status code and reason. */
export function closeFrame(code = 1000, reason = ""): Buffer {
  return encodeFrame(OP_CLOSE, closePayload(code, reason));
}

/** Build a client->server (masked) close frame with a status code and reason. */
export function clientCloseFrame(code = 1000, reason = ""): Buffer {
  return encodeClientFrame(OP_CLOSE, closePayload(code, reason));
}
