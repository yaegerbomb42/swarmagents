/**
 * RFB (VNC) client-to-server message filter used to enforce a read-only
 * desktop session at the proxy.
 *
 * A "view only" flag on the VNC client is just client-side etiquette — the
 * proxy is the enforcement point. The DesktopBridge terminates the RFB
 * handshake toward the browser, so every byte this filter sees is a
 * post-handshake client->server RFB message. It frames messages from the RFB
 * type table and drops input messages (key events, pointer events, clipboard)
 * while forwarding everything else (framebuffer requests, encodings, format
 * negotiation) so the screen keeps rendering.
 *
 * RFB messages are self-terminating, so framing is a small state machine over
 * the stream: a message whose full size is not known yet is held back.
 *
 * FAIL-CLOSED: in view mode an unknown message type, an unsupported QEMU
 * subtype, or an over-limit variable-length header throws RfbProtocolError
 * instead of degrading to pass-through. The bridge terminates the session
 * (WebSocket 1002) on that error, so a view-only client can never smuggle
 * input past the filter by sending an opcode the filter does not understand.
 * The upstream connection still carries the server-side viewonly=1 flag as a
 * second layer.
 */

export type RfbFilterMode = "view" | "control";

export class RfbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RfbProtocolError";
  }
}

const MAX_ENCODINGS = 256;
const MAX_SCREENS = 16;
/**
 * Absolute cap on a ClientCutText payload (1 MiB). A larger declared length
 * is a protocol error, never a multi-gigabyte skip: without the cap a client
 * could declare a 4 GB cut-text and make the filter swallow the next 4 GB of
 * the stream. A 1 MiB declaration is still skipped without buffering it.
 */
export const MAX_CUT_TEXT_BYTES = 1_048_576;
/** Default cap on framed RFB messages per second (flood protection). */
export const DEFAULT_MAX_EVENTS_PER_SECOND = 1000;

/**
 * One framed client->server RFB message, as decoded by the filter. `seq` is
 * a monotonic sequence number assigned by the filter in framing order: the
 * next event must always carry exactly `lastSeq + 1`, so a gap or a replay
 * is a protocol violation rather than a silent resync.
 */
export interface RfbEvent {
  type: number;
  seq: number;
  size: number;
  payload: Buffer;
}

export interface RfbInputFilterOptions {
  /** Cap on framed messages per second. Default DEFAULT_MAX_EVENTS_PER_SECOND. */
  maxEventsPerSecond?: number;
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Largest legal total size of a message of the given type. Variable-length
 * types use their absolute caps (SetEncodings count, ClientCutText length,
 * SetDesktopSize screens); unknown types have no legal size.
 */
function maxSizeForType(type: number): number {
  switch (type) {
    case 0:
      return 20;
    case 2:
      return 4 + MAX_ENCODINGS * 4;
    case 3:
      return 10;
    case 4:
      return 8;
    case 5:
      return 6;
    case 6:
      return 8 + MAX_CUT_TEXT_BYTES;
    case 150:
      return 10;
    case 248:
      return 9 + 255;
    case 250:
      return 4;
    case 251:
      return 8 + MAX_SCREENS * 16;
    case 255:
      return 12;
    default:
      return 0;
  }
}

function isInputMessage(type: number): boolean {
  return type === 4 || type === 5 || type === 6 || type === 250 || type === 251 || type === 255;
}

const MESSAGE_FIXED_SIZE: Record<number, number> = {
  0: 20, // SetPixelFormat
  2: -1, // SetEncodings
  3: 10, // FramebufferUpdateRequest
  4: 8, // KeyEvent (type, down-flag, 2 pad, keysym u32)
  5: 6, // PointerEvent
  6: -1, // ClientCutText
  150: 10, // EnableContinuousUpdates
  248: -1, // ClientFence
  250: 4, // xvp
  251: -1, // SetDesktopSize
  255: -1, // QEMU extended key event
};

export class RfbInputFilter {
  /**
   * The filter never degrades to unfiltered pass-through: an unknown message
   * type, an over-limit header, a sequence gap, or a rate-limit breach is a
   * protocol error, not a reason to stop filtering.
   */
  static readonly failClosed = true;

  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private skipRemaining = 0;
  dropped = 0;
  /** Sequence number assigned to the next framed event. */
  private nextSeq = 0;
  private readonly maxEventsPerSecond: number;
  private readonly now: () => number;
  private windowStartMs = 0;
  private eventsInWindow = 0;

  constructor(
    private readonly mode: RfbFilterMode,
    options: RfbInputFilterOptions = {},
  ) {
    this.maxEventsPerSecond = options.maxEventsPerSecond ?? DEFAULT_MAX_EVENTS_PER_SECOND;
    this.now = options.now ?? Date.now;
  }

  /** Sequence number of the last validated event, or -1 before the first. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Per-event policy: monotonic sequence, per-event bounds, and rate limit.
   * Throws RfbProtocolError on any violation (fail closed). A valid event
   * advances the sequence and counts toward the rate window.
   */
  applyPolicy(event: RfbEvent): void {
    if (event.seq !== this.nextSeq) {
      throw new RfbProtocolError(
        `RFB event sequence ${event.seq} is not the expected ${this.nextSeq}`,
      );
    }
    const max = maxSizeForType(event.type);
    if (max === 0 || event.size > max || event.payload.length !== event.size) {
      throw new RfbProtocolError(
        `RFB event type ${event.type} size ${event.size} exceeds the per-event bound`,
      );
    }
    const nowMs = this.now();
    if (nowMs - this.windowStartMs >= 1000) {
      this.windowStartMs = nowMs;
      this.eventsInWindow = 0;
    }
    if (this.eventsInWindow >= this.maxEventsPerSecond) {
      throw new RfbProtocolError("RFB event rate limit exceeded");
    }
    this.eventsInWindow++;
    this.nextSeq++;
  }

  push(chunk: Buffer): Buffer {
    if (this.mode === "control") return chunk;

    if (this.skipRemaining > 0) {
      const n = Math.min(this.skipRemaining, chunk.length);
      this.skipRemaining -= n;
      chunk = chunk.subarray(n);
      if (chunk.length === 0) return Buffer.alloc(0);
    }

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];

    while (this.buffer.length > 0) {
      const type = this.buffer.readUInt8(0);
      let size = MESSAGE_FIXED_SIZE[type] ?? -2;
      if (size === -2) {
        // Fail closed in view mode: never fall back to unfiltered pass-through.
        throw new RfbProtocolError(`Unsupported RFB client message type ${type} in view mode`);
      }
      if (size === -1) {
        if (type === 2) {
          if (this.buffer.length < 4) break;
          const count = this.buffer.readUInt16BE(2);
          if (count > MAX_ENCODINGS) throw new RfbProtocolError("SetEncodings count exceeds limit");
          size = 4 + count * 4;
        } else if (type === 6) {
          if (this.buffer.length < 8) break;
          // RFC 6143 §7.5.6: standard ClientCutText carries an unsigned length;
          // TigerVNC / noVNC ExtendedClipboard passes a negative int32 length
          // whose payload has `-signedLength` bytes. Both stay capped and
          // dropped cleanly in view mode.
          const signedLength = this.buffer.readInt32BE(4);
          const length = signedLength < 0 ? -signedLength : signedLength;
          if (length > MAX_CUT_TEXT_BYTES) {
            throw new RfbProtocolError("ClientCutText length exceeds limit");
          }
          size = 8 + length;
        } else if (type === 248) {
          if (this.buffer.length < 9) break;
          size = 9 + this.buffer.readUInt8(8);
        } else if (type === 251) {
          if (this.buffer.length < 8) break;
          const screens = this.buffer.readUInt8(6);
          if (screens > MAX_SCREENS) throw new RfbProtocolError("SetDesktopSize screens exceed limit");
          size = 8 + screens * 16;
        } else {
          if (this.buffer.length < 2) break;
          const subType = this.buffer.readUInt8(1);
          if (subType !== 0) {
            throw new RfbProtocolError(`Unsupported QEMU RFB subtype ${subType} in view mode`);
          }
          size = 12;
        }
      }
      if (this.buffer.length < size) {
        if (isInputMessage(type)) {
          this.dropped++;
          this.skipRemaining = size - this.buffer.length;
          this.buffer = Buffer.alloc(0);
        }
        break;
      }

      const message = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      // Every framed message is a policy-checked event: monotonic sequence,
      // per-event bounds, and rate limit. A violation fails closed.
      const bytes = Buffer.from(message);
      this.applyPolicy({ type, seq: this.nextSeq, size, payload: bytes });
      if (isInputMessage(type)) {
        this.dropped++;
      } else {
        out.push(bytes);
      }
    }
    return Buffer.concat(out);
  }
}
