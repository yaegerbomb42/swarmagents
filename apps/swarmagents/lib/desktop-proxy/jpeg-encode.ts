/**
 * Minimal baseline JPEG (JFIF) encoder for keyframe capture.
 *
 * The desktop frame tap holds decoded RGBA frames host-side and needs a
 * compact still-image encoding for the KeyframeStore. No existing encoder in
 * the codebase turns raw RGBA into JPEG (the browser frame path receives
 * ready-made JPEG bytes from CDP, and the VM screenshot path writes PNGs
 * in-VM), so this module provides the one host-side encoder. It is a plain
 * ITU T.81 baseline encoder: 4:4:4 (no chroma subsampling), standard
 * Annex K quantization and Huffman tables, quality-scaled. Pure TypeScript,
 * no dependencies; deterministic output for a given input.
 *
 * Input is RGBA8888 (4 bytes per pixel, alpha ignored). Dimensions need not
 * be multiples of 8 — edges are replicated.
 */

/** Zigzag scan order: index into a row-major 8x8 block, in zigzag sequence. */
const ZIGZAG: readonly number[] = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60,
  61, 54, 47, 55, 62, 63,
];

/** Standard luminance quantization table (row-major), quality 50. */
const QUANT_LUMA: readonly number[] = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13,
  16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56,
  68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103,
  121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Standard chrominance quantization table (row-major), quality 50. */
const QUANT_CHROMA: readonly number[] = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26,
  56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

interface HuffmanTable {
  /** Code lengths histogram: bits[i] = number of codes of length i+1. */
  bits: readonly number[];
  /** Symbols in code order. */
  vals: readonly number[];
}

const HUFF_DC_LUMA: HuffmanTable = {
  bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const HUFF_DC_CHROMA: HuffmanTable = {
  bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const HUFF_AC_LUMA: HuffmanTable = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const HUFF_AC_CHROMA: HuffmanTable = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
    0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
    0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
    0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
    0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

interface EncodedHuffman {
  /** symbol -> (code, length) packed as code * 32 + length. */
  bySymbol: Map<number, number>;
}

function buildHuffman(table: HuffmanTable): EncodedHuffman {
  const bySymbol = new Map<number, number>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < table.bits[len - 1]!; i++) {
      bySymbol.set(table.vals[k++]!, code * 32 + len);
      code++;
    }
    code <<= 1;
  }
  return { bySymbol };
}

const ENC_DC_LUMA = buildHuffman(HUFF_DC_LUMA);
const ENC_DC_CHROMA = buildHuffman(HUFF_DC_CHROMA);
const ENC_AC_LUMA = buildHuffman(HUFF_AC_LUMA);
const ENC_AC_CHROMA = buildHuffman(HUFF_AC_CHROMA);

/** Scale a quality-50 quantization table to `quality` (1..100). */
function scaleQuant(base: readonly number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** Forward DCT cosine table: COS[u][x] = cos((2x+1)*u*pi/16). */
const COS: number[][] = Array.from({ length: 8 }, (_, u) =>
  Array.from({ length: 8 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)),
);
const C0 = Math.SQRT1_2;

/** One 8x8 block, level-shifted samples in, quantized coefficients out (row-major). */
function fdctQuantize(samples: Float64Array, quant: readonly number[]): Int32Array {
  const out = new Int32Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        const cosY = COS[v]![y]!;
        const row = y * 8;
        for (let x = 0; x < 8; x++) {
          sum += samples[row + x]! * COS[u]![x]! * cosY;
        }
      }
      const cu = u === 0 ? C0 : 1;
      const cv = v === 0 ? C0 : 1;
      const coeff = (cu * cv * sum) / 4;
      out[v * 8 + u] = Math.round(coeff / quant[v * 8 + u]!);
    }
  }
  return out;
}

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private accBits = 0;

  write(code: number, length: number): void {
    this.acc = (this.acc << length) | (code & ((1 << length) - 1));
    this.accBits += length;
    while (this.accBits >= 8) {
      const byte = (this.acc >> (this.accBits - 8)) & 0xff;
      this.bytes.push(byte);
      if (byte === 0xff) this.bytes.push(0x00); // byte stuffing
      this.accBits -= 8;
      this.acc &= (1 << this.accBits) - 1;
    }
  }

  writeSymbol(table: EncodedHuffman, symbol: number): void {
    const packed = table.bySymbol.get(symbol);
    if (packed === undefined) throw new Error(`no Huffman code for symbol ${symbol}`);
    this.write(Math.floor(packed / 32), packed % 32);
  }

  /** Pad the final partial byte with 1-bits (per spec) and return all bytes. */
  finish(): Uint8Array {
    if (this.accBits > 0) {
      const pad = 8 - this.accBits;
      this.write((1 << pad) - 1, pad);
    }
    return Uint8Array.from(this.bytes);
  }
}

/** Bit length of |value| (JPEG "category" / SSSS). */
function category(value: number): number {
  let v = Math.abs(value);
  let n = 0;
  while (v > 0) {
    n++;
    v >>= 1;
  }
  return n;
}

/** Encode one quantized block; returns the DC coefficient for prediction. */
function encodeBlock(
  writer: BitWriter,
  block: Int32Array,
  prevDc: number,
  dcTable: EncodedHuffman,
  acTable: EncodedHuffman,
): number {
  const dc = block[0]!;
  const diff = dc - prevDc;
  const cat = category(diff);
  writer.writeSymbol(dcTable, cat);
  if (cat > 0) {
    // Negative values are stored as (value - 1) in `cat` bits (one's complement).
    writer.write(diff < 0 ? diff - 1 : diff, cat);
  }
  let run = 0;
  for (let i = 1; i < 64; i++) {
    const coeff = block[ZIGZAG[i]!]!;
    if (coeff === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      writer.writeSymbol(acTable, 0xf0); // ZRL
      run -= 16;
    }
    const catAc = category(coeff);
    writer.writeSymbol(acTable, (run << 4) | catAc);
    writer.write(coeff < 0 ? coeff - 1 : coeff, catAc);
    run = 0;
  }
  if (run > 0) writer.writeSymbol(acTable, 0x00); // EOB
  return dc;
}

function marker(out: number[], code: number): void {
  out.push(0xff, code);
}

function segment(out: number[], code: number, payload: number[]): void {
  marker(out, code);
  const len = payload.length + 2;
  out.push((len >> 8) & 0xff, len & 0xff, ...payload);
}

function quantSegment(quant: readonly number[], id: number): number[] {
  // DQT stores coefficients in zigzag order.
  return [id, ...ZIGZAG.map((idx) => quant[idx]!)];
}

function huffSegment(table: HuffmanTable, idAndClass: number): number[] {
  return [idAndClass, ...table.bits, ...table.vals];
}

export interface JpegEncodeOptions {
  /** 1..100, default 75. */
  quality?: number;
}

/**
 * Encode an RGBA8888 frame (alpha ignored) as a baseline JFIF JPEG.
 * Throws on invalid dimensions or a short buffer; callers that must not
 * throw (the frame tap) catch and degrade.
 */
export function encodeJpeg(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: JpegEncodeOptions = {},
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid JPEG dimensions ${width}x${height}`);
  }
  if (width > 0xffff || height > 0xffff) throw new Error("JPEG dimensions exceed 65535");
  if (rgba.byteLength < width * height * 4) throw new Error("RGBA buffer too short");

  const quality = options.quality ?? 75;
  const quantLuma = scaleQuant(QUANT_LUMA, quality);
  const quantChroma = scaleQuant(QUANT_CHROMA, quality);

  // Convert to YCbCr planes (float, level shift applied at block extraction).
  const yPlane = new Float64Array(width * height);
  const cbPlane = new Float64Array(width * height);
  const crPlane = new Float64Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    yPlane[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cbPlane[i] = -0.16873589 * r - 0.33126411 * g + 0.5 * b + 128;
    crPlane[i] = 0.5 * r - 0.41868759 * g - 0.08131241 * b + 128;
  }

  const header: number[] = [];
  marker(header, 0xd8); // SOI
  segment(header, 0xe0, [
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    1, 1, // version 1.1
    0, // density units: none
    0, 1, 0, 1, // x/y density
    0, 0, // no thumbnail
  ]);
  segment(header, 0xdb, [...quantSegment(quantLuma, 0), ...quantSegment(quantChroma, 1)]);
  segment(header, 0xc0, [
    8, // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    3, // components
    1, 0x11, 0, // Y:  1x1 sampling, quant table 0
    2, 0x11, 1, // Cb: 1x1 sampling, quant table 1
    3, 0x11, 1, // Cr: 1x1 sampling, quant table 1
  ]);
  segment(header, 0xc4, [
    ...huffSegment(HUFF_DC_LUMA, 0x00),
    ...huffSegment(HUFF_AC_LUMA, 0x10),
    ...huffSegment(HUFF_DC_CHROMA, 0x01),
    ...huffSegment(HUFF_AC_CHROMA, 0x11),
  ]);
  segment(header, 0xda, [
    3, // components in scan
    1, 0x00, // Y:  DC table 0, AC table 0
    2, 0x11, // Cb: DC table 1, AC table 1
    3, 0x11, // Cr: DC table 1, AC table 1
    0, 63, 0, // Ss, Se, Ah/Al
  ]);

  const writer = new BitWriter();
  const block = new Float64Array(64);
  let prevDcY = 0;
  let prevDcCb = 0;
  let prevDcCr = 0;
  const extractBlock = (plane: Float64Array, bx: number, by: number): void => {
    for (let y = 0; y < 8; y++) {
      const sy = Math.min(height - 1, by + y);
      for (let x = 0; x < 8; x++) {
        const sx = Math.min(width - 1, bx + x);
        block[y * 8 + x] = plane[sy * width + sx]! - 128;
      }
    }
  };
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      extractBlock(yPlane, bx, by);
      prevDcY = encodeBlock(writer, fdctQuantize(block, quantLuma), prevDcY, ENC_DC_LUMA, ENC_AC_LUMA);
      extractBlock(cbPlane, bx, by);
      prevDcCb = encodeBlock(writer, fdctQuantize(block, quantChroma), prevDcCb, ENC_DC_CHROMA, ENC_AC_CHROMA);
      extractBlock(crPlane, bx, by);
      prevDcCr = encodeBlock(writer, fdctQuantize(block, quantChroma), prevDcCr, ENC_DC_CHROMA, ENC_AC_CHROMA);
    }
  }
  const scan = writer.finish();

  const out = new Uint8Array(header.length + scan.length + 2);
  out.set(header, 0);
  out.set(scan, header.length);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9; // EOI
  return out;
}
