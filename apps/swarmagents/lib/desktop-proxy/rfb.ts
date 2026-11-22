/**
 * Minimal RFB (VNC) protocol support for the desktop proxy.
 *
 * The proxy terminates the RFB handshake at both ends:
 *   - toward the browser it plays the VNC *server* and advertises the "None"
 *     security type, so the browser never asks for a password;
 *   - toward the container it plays the VNC *client* and performs the classic
 *     VNCAuth challenge/response with the driver-provided password — this is
 *     where the password is injected server-side; it never reaches the browser.
 *
 * After both handshakes complete, the proxy splices the two byte streams
 * (with view-mode input filtering on the browser->container direction).
 *
 * DES here implements the classic VNC variant of DES (bits of each key byte
 * reversed, single ECB block) used by VNCAuth. It is purpose-built for the
 * 16-byte challenge/response and deliberately keeps to a single block so the
 * whole module is dependency-free and verifiable against published vectors.
 */

export const RFB_VERSION = "RFB 003.008\n";
const RFB_VERSION_12 = Buffer.from(RFB_VERSION);

export const SECURITY_NONE = 1;
export const SECURITY_VNC_AUTH = 2;

// --- classic VNC DES (single ECB block) -------------------------------

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
  12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
  22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
  59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6,
  61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4,
  26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40,
  51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const S_BOXES: readonly (readonly number[])[] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

function reverseBits(b: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    out = (out << 1) | (b & 1);
    b >>= 1;
  }
  return out;
}

/** Bit array helpers — MSB-first, index 0 = bit 7 of the first byte. */
type BitArr = number[];

function bytesToBits(bytes: Buffer): BitArr {
  const bits: BitArr = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  return bits;
}

function bitsToBytes(bits: BitArr): Buffer {
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

/** Generic table permutation over bit arrays (tables are 1-based). */
function permuteBits(input: BitArr, table: readonly number[], outLen: number): BitArr {
  const out: BitArr = new Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[table[i] - 1];
  return out;
}

function xorBits(a: BitArr, b: BitArr): BitArr {
  const out: BitArr = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** DES key schedule: 16 round keys of 48 bits each. */
function desKeySchedule(key8: Buffer): BitArr[] {
  const key56 = permuteBits(bytesToBits(key8), PC1, 56);
  let c = key56.slice(0, 28);
  let d = key56.slice(28);
  const subkeys: BitArr[] = [];
  for (let round = 0; round < 16; round++) {
    for (let i = 0; i < SHIFTS[round]; i++) {
      c = [...c.slice(1), c[0]];
      d = [...d.slice(1), d[0]];
    }
    subkeys.push(permuteBits([...c, ...d], PC2, 48));
  }
  return subkeys;
}

function feistel(rBits: BitArr, subkey: BitArr): BitArr {
  const e = permuteBits(rBits, E, 48);
  const x = xorBits(e, subkey);
  const sOut: BitArr = [];
  for (let i = 0; i < 8; i++) {
    const chunk = x.slice(i * 6, i * 6 + 6);
    const row = (chunk[0] << 1) | chunk[5];
    const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
    const value = S_BOXES[i][row * 16 + col];
    sOut.push((value >> 3) & 1, (value >> 2) & 1, (value >> 1) & 1, value & 1);
  }
  return permuteBits(sOut, P, 32);
}

/** Encrypt one 8-byte block with DES-ECB (no padding). */
export function desEcbEncryptBlock(key8: Buffer, block: Buffer): Buffer {
  if (key8.length !== 8 || block.length !== 8) {
    throw new Error("DES block encryption requires 8-byte key and block");
  }
  const subkeys = desKeySchedule(key8);
  const blockBits = bytesToBits(block);
  const ip = permuteBits(blockBits, IP, 64);
  let l = ip.slice(0, 32);
  let r = ip.slice(32);
  for (let i = 0; i < 16; i++) {
    const nextL = r;
    const nextR = xorBits(l, feistel(r, subkeys[i]));
    l = nextL;
    r = nextR;
  }
  const preoutput = [...r, ...l];
  return bitsToBytes(permuteBits(preoutput, FP, 64));
}

/**
 * Classic VNC Auth response: two DES-ECB blocks over the 16-byte challenge
 * under a key made from the first 8 password bytes (NUL-padded) with each
 * byte's bits reversed (per the VNC authentication specification).
 */
export function vncDesResponse(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== 16) {
    throw new Error("VNC challenge must be 16 bytes");
  }
  const key8 = Buffer.alloc(8);
  const pw = Buffer.from(password, "utf8");
  for (let i = 0; i < 8; i++) {
    key8[i] = reverseBits(i < pw.length ? pw[i] : 0);
  }
  return Buffer.concat([
    desEcbEncryptBlock(key8, challenge.subarray(0, 8)),
    desEcbEncryptBlock(key8, challenge.subarray(8, 16)),
  ]);
}

// --- RFB handshake state machines ---------------------------------------

export interface RfbHandshakeOutput {
  /** Bytes to send to the peer. */
  out: Buffer;
  /** Bytes the peer sent after the handshake completed (message stream). */
  surplus: Buffer;
}

class BufferWindow {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  get size(): number {
    return this.length;
  }

  take(n: number): Buffer {
    const out = Buffer.alloc(n);
    let offset = 0;
    while (offset < n) {
      const first = this.chunks[0];
      const take = Math.min(first.length, n - offset);
      first.copy(out, offset, 0, take);
      offset += take;
      if (take === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(take);
    }
    this.length -= n;
    return out;
  }

  /** Copy the first n bytes without consuming them (n <= size). */
  peek(n: number): Buffer {
    const out = Buffer.alloc(n);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= n) break;
      const take = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
    }
    return out;
  }
}

/**
 * Handshake played toward the browser (proxy is the VNC server). Advertises
 * only security type "None", so the browser never receives or sends a
 * password. ServerInit is deferred until the upstream server's dimensions are
 * known (serverInit() is called by the bridge once the client handshake is
 * done).
 *
 * RFB is server-first (RFC 6143 §7.1): call start() once at connect to emit
 * the version string before feeding any client bytes. A real client (noVNC)
 * sends nothing until it has seen the server version, so waiting for the
 * client to speak first deadlocks the handshake.
 */
export class RfbServerHandshake {
  private state: "version" | "select" | "result" | "clientinit" | "done" = "version";
  private win = new BufferWindow();
  private versionSent = false;
  done = false;

  /**
   * Kick the handshake off: the server sends its version string immediately
   * on connect, before reading anything from the client. The bridge calls
   * this once at construction and writes the result to the browser; repeat
   * calls return nothing.
   */
  start(): Buffer {
    if (this.versionSent) return Buffer.alloc(0);
    this.versionSent = true;
    return RFB_VERSION_12;
  }

  /** Feed bytes from the browser. Returns bytes to send back to the browser. */
  feed(chunk: Buffer): RfbHandshakeOutput {
    this.win.push(chunk);
    let out = Buffer.alloc(0);
    while (!this.done) {
      if (this.state === "version") {
        if (this.win.size < 12) break;
        const version = this.win.take(12);
        if (!version.subarray(0, 4).equals(Buffer.from("RFB "))) {
          throw new Error("Client sent an invalid RFB version string");
        }
        // The client's version reply completes the version exchange; only
        // now does the server advertise its security types (RFC 6143 §7.1).
        out = Buffer.concat([out, Buffer.from([1, SECURITY_NONE])]);
        this.state = "select";
      } else if (this.state === "select") {
        if (this.win.size < 1) break;
        this.win.take(1); // security-type choice (should be 1)
        out = Buffer.concat([out, Buffer.from([0, 0, 0, 0])]); // SecurityResult OK
        this.state = "clientinit";
      } else if (this.state === "clientinit") {
        if (this.win.size < 1) break;
        this.win.take(1); // ClientInit (shared flag) — accepted, irrelevant to us
        this.state = "done";
        this.done = true;
      }
    }
    return { out, surplus: this.done ? this.win.take(this.win.size) : Buffer.alloc(0) };
  }

  /** Build the ServerInit message once the upstream framebuffer size is known. */
  serverInit(width: number, height: number, name = "SwarmAgents Desktop"): Buffer {
    const nameBuf = Buffer.from(name, "utf8");
    // ServerInit = 20-byte fixed part (width, height, 16-byte pixel format)
    // + U32 name length + name. The name length lives at offset 20.
    const init = Buffer.alloc(24 + nameBuf.length);
    init.writeUInt16BE(Math.max(1, width), 0);
    init.writeUInt16BE(Math.max(1, height), 2);
    // Pixel format: 32bpp, 24-bit depth, true color, 8-bit channels.
    init[4] = 32; // bpp
    init[5] = 24; // depth
    init[6] = 0; // big-endian flag
    init[7] = 1; // true-color flag
    init.writeUInt16BE(255, 8); // red max
    init.writeUInt16BE(255, 10); // green max
    init.writeUInt16BE(255, 12); // blue max
    init[14] = 16; // red shift
    init[15] = 8; // green shift
    init[16] = 0; // blue shift
    init.writeUInt32BE(nameBuf.length, 20);
    nameBuf.copy(init, 24);
    return init;
  }
}

/**
 * Handshake played toward the container (proxy is the VNC client). Selects
 * VNCAuth (or "None" if the server offers it) and answers the challenge with
 * the password the driver stores — the server-side injection point.
 */
export class RfbClientHandshake {
  private state: "version" | "security-count" | "security-types" | "challenge" | "result" | "serverinit" | "done" = "version";
  private win = new BufferWindow();
  private remainingTypes = 0;
  private selected = 0;
  done = false;
  width = 0;
  height = 0;

  constructor(private readonly password: string) {}

  /**
   * Kick the handshake off. RFB is server-first (RFC 6143 §7.1): the server
   * sends its version string immediately on connect and the client replies
   * with its own, so there is nothing to send yet — the version reply is
   * emitted by feed() once the server's banner arrives. Kept for symmetry
   * with RfbServerHandshake.start() so the bridge can treat both ends the
   * same way: write whatever start() returns, then feed peer bytes.
   */
  start(): Buffer {
    return Buffer.alloc(0);
  }

  /** Feed bytes from the upstream server. Returns bytes to send upstream. */
  feed(chunk: Buffer): RfbHandshakeOutput {
    this.win.push(chunk);
    let out = Buffer.alloc(0);
    while (!this.done) {
      if (this.state === "version") {
        if (this.win.size < 12) break;
        const version = this.win.take(12);
        if (!version.subarray(0, 4).equals(Buffer.from("RFB "))) {
          throw new Error("Upstream VNC server sent an invalid RFB version string");
        }
        // The server spoke first; reply with our version string, then wait
        // for its security types (RFC 6143 §7.1).
        out = Buffer.concat([out, RFB_VERSION_12]);
        this.state = "security-count";
      } else if (this.state === "security-count") {
        if (this.win.size < 1) break;
        const count = this.win.peek(1).readUInt8(0);
        if (count === 0) {
          // Failure: count byte + reason length (unused). Peek-then-take so a
          // split message is not consumed piecemeal.
          if (this.win.size < 5) break;
          this.win.take(5);
          throw new Error("Upstream VNC server reports a security failure");
        }
        this.win.take(1);
        this.remainingTypes = count;
        this.state = "security-types";
      } else if (this.state === "security-types") {
        if (this.win.size < this.remainingTypes) break;
        const types = this.win.take(this.remainingTypes);
        let choice = SECURITY_NONE;
        for (const t of types) {
          if (t === SECURITY_VNC_AUTH) {
            choice = SECURITY_VNC_AUTH;
            break;
          }
        }
        if (!types.includes(choice)) {
          throw new Error("Upstream VNC server offers no supported security type");
        }
        this.selected = choice;
        out = Buffer.concat([out, Buffer.from([choice])]);
        this.state = choice === SECURITY_VNC_AUTH ? "challenge" : "result";
      } else if (this.state === "challenge") {
        if (this.win.size < 16) break;
        const challenge = this.win.take(16);
        out = Buffer.concat([out, vncDesResponse(this.password, challenge)]);
        this.state = "result";
      } else if (this.state === "result") {
        if (this.win.size < 4) break;
        const result = this.win.take(4).readUInt32BE(0);
        if (result !== 0) {
          throw new Error("Upstream VNC server rejected the authentication");
        }
        out = Buffer.concat([out, Buffer.from([1])]); // ClientInit: shared
        this.state = "serverinit";
      } else if (this.state === "serverinit") {
        // ServerInit = 20-byte fixed part + U32 name length + name (24 bytes
        // before the name). Only consume it once complete: it can arrive split
        // across WebSocket messages (websockify forwards each VNC TCP read as
        // its own frame).
        if (this.win.size < 24) break;
        const head = this.win.peek(24);
        const nameLen = head.readUInt32BE(20);
        if (nameLen > 1024) throw new Error("Upstream ServerInit name is unreasonable");
        if (this.win.size < 24 + nameLen) break;
        this.win.take(24 + nameLen);
        this.width = head.readUInt16BE(0);
        this.height = head.readUInt16BE(2);
        this.state = "done";
        this.done = true;
      }
    }
    return { out, surplus: this.done ? this.win.take(this.win.size) : Buffer.alloc(0) };
  }
}
