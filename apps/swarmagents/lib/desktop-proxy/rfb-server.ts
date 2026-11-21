/**
 * Upstream RFB server-message framing used by opt-in framebuffer recording.
 *
 * The proxy is a relay: it forwards the container's VNC server bytes to the
 * browser without decoding pixels. To record only the *frames* — the
 * FramebufferUpdate messages that carry screen content — and never control
 * messages (Bell, ServerCutText, …) or input (which only ever travel
 * client→server and so never appear here), we must frame the server→client
 * RFB message stream and extract type-0 messages.
 *
 * Framing needs the size of each message. Fixed-size and self-describing
 * messages (Bell, ServerCutText, SetColourMapEntries, ServerFence) are
 * framed directly. A FramebufferUpdate is variable: its rectangles must be
 * walked, which requires knowing each rectangle's encoding size. We support
 * the encodings a real desktop path produces with a raw-capable viewer —
 * Raw (0) and CopyRect (1) — and treat any other encoding as unsupported:
 * the recorder stops (with a note) instead of mis-framing the stream.
 * None of this throws across the bridge: the recorder catches unsupported
 * conditions and simply stops writing.
 */

export interface RfbServerFrame {
  /** RFB server message type. */
  type: number;
  /** The complete, still-encoded RFB server message bytes. */
  raw: Buffer;
}

/** Raised when a server message/encoding cannot be framed safely. */
export class RfbServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RfbServerUnsupportedError";
  }
}

const TYPE_FRAMEBUFFER_UPDATE = 0;
const TYPE_SET_COLOURMAP_ENTRIES = 1;
const TYPE_BELL = 2;
const TYPE_SERVER_CUT_TEXT = 3;
const TYPE_SERVER_FENCE = 5;

const ENCODING_RAW = 0;
const ENCODING_COPY_RECT = 1;

/** Rect header (x,y,w,h,encoding) before any pixel payload. */
const RECT_HEADER_BYTES = 12;

/**
 * Frame a stream of RFB server messages. Feed any chunk of the upstream
 * byte stream; returns complete framed messages in order, buffering partial
 * messages until they arrive. Throws {@link RfbServerUnsupportedError} when it
 * meets a message type or framebuffer encoding whose size it cannot determine.
 */
export class RfbServerDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly bytesPerPixel: number;

  constructor(bytesPerPixel = 4) {
    this.bytesPerPixel = bytesPerPixel > 0 ? bytesPerPixel : 4;
  }

  push(chunk: Buffer): RfbServerFrame[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const out: RfbServerFrame[] = [];
    for (;;) {
      if (this.buffer.length < 1) break;
      const type = this.buffer.readUInt8(0);
      const size = this.frameSize(type);
      if (size === null) {
        throw new RfbServerUnsupportedError(`cannot frame server message type ${type}`);
      }
      if (size < 0) {
        // Variable-length message: not complete yet. (frameSize only returns
        // negative when the fixed header itself is incomplete.)
        break;
      }
      if (this.buffer.length < size) break; // wait for more bytes
      const raw = Buffer.from(this.buffer.subarray(0, size));
      this.buffer = this.buffer.subarray(size);
      out.push({ type, raw });
    }
    return out;
  }

  /**
   * Total byte size of the message at the front of `buffer`, or:
   *   - `null` when the message type is unsupported;
   *   - `-1` when the fixed portion is incomplete (need more bytes).
   */
  private frameSize(type: number): number | null {
    switch (type) {
      case TYPE_BELL:
        return 1;
      case TYPE_SERVER_FENCE: {
        if (this.buffer.length < 6) return -1;
        const len = this.buffer.readUInt8(5);
        return 6 + len;
      }
      case TYPE_SERVER_CUT_TEXT: {
        if (this.buffer.length < 8) return -1;
        const len = this.buffer.readUInt32BE(4);
        return 8 + len;
      }
      case TYPE_SET_COLOURMAP_ENTRIES: {
        if (this.buffer.length < 6) return -1;
        const colours = this.buffer.readUInt16BE(4);
        return 6 + colours * 6;
      }
      case TYPE_FRAMEBUFFER_UPDATE: {
        if (this.buffer.length < 4) return -1;
        const rects = this.buffer.readUInt16BE(2);
        return this.fbuSize(rects);
      }
      default:
        return null;
    }
  }

  private fbuSize(rects: number): number {
    let offset = 4;
    for (let i = 0; i < rects; i++) {
      if (this.buffer.length < offset + RECT_HEADER_BYTES) return -1;
      const width = this.buffer.readUInt16BE(offset + 4);
      const height = this.buffer.readUInt16BE(offset + 6);
      const encoding = this.buffer.readUInt32BE(offset + 8);
      offset += RECT_HEADER_BYTES;
      if (encoding === ENCODING_RAW) {
        offset += width * height * this.bytesPerPixel;
      } else if (encoding === ENCODING_COPY_RECT) {
        offset += 4;
      } else {
        throw new RfbServerUnsupportedError(`unsupported framebuffer encoding ${encoding}`);
      }
      if (offset < 0 || offset > 64 * 1024 * 1024) {
        throw new RfbServerUnsupportedError("framebuffer message size out of range");
      }
    }
    return offset;
  }
}
