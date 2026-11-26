/**
 * Minimal decoder for the desktop proxy's frame recordings.
 *
 * A recording is a concatenation of RFB FramebufferUpdate messages (type 0)
 * with Raw (0) and CopyRect (1) rectangles — exactly what frame-recorder.ts
 * appends, and nothing else. The proxy's browser-facing ServerInit fixes the
 * pixel format at 32bpp, little-endian RGB channels, so Raw pixels arrive as
 * B,G,R,X bytes and CopyRect carries a source x/y.
 *
 * Pure: no DOM, no I/O. The replay component applies the parsed rectangles to
 * a canvas framebuffer.
 */

export const REPLAY_BYTES_PER_PIXEL = 4;
export const REPLAY_FRAME_INTERVAL_MS = 200;

export interface ReplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
  /** Absolute byte offset into the recording's pixel data. */
  offset: number;
  /** CopyRect source corner. */
  sourceX?: number;
  sourceY?: number;
}

export interface ReplayUpdate {
  rects: ReplayRect[];
  /** Byte offset just past this update in the recording. */
  end: number;
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * Parse all complete FramebufferUpdate messages. A truncated tail (a cap
 * stopped the recording mid-frame) or any other message type ends the replay
 * cleanly — earlier updates stay playable.
 */
export function parseDesktopReplay(bytes: Uint8Array): ReplayUpdate[] {
  const updates: ReplayUpdate[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0) break;
    const count = u16(bytes, offset + 2);
    let cursor = offset + 4;
    const rects: ReplayRect[] = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      if (cursor + 12 > bytes.length) {
        complete = false;
        break;
      }
      const x = u16(bytes, cursor);
      const y = u16(bytes, cursor + 2);
      const width = u16(bytes, cursor + 4);
      const height = u16(bytes, cursor + 6);
      const encoding = u32(bytes, cursor + 8);
      cursor += 12;
      const rect: ReplayRect = { x, y, width, height, encoding, offset: cursor };
      if (encoding === 0) {
        const length = width * height * REPLAY_BYTES_PER_PIXEL;
        if (cursor + length > bytes.length) {
          complete = false;
          break;
        }
        cursor += length;
      } else if (encoding === 1) {
        if (cursor + 4 > bytes.length) {
          complete = false;
          break;
        }
        rect.sourceX = u16(bytes, cursor);
        rect.sourceY = u16(bytes, cursor + 2);
        cursor += 4;
      } else {
        complete = false;
        break;
      }
      rects.push(rect);
    }
    if (!complete) break;
    updates.push({ rects, end: cursor });
    offset = cursor;
  }
  return updates;
}

/** A fully opaque black framebuffer to replay rectangles onto. */
export function createReplayFramebuffer(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * REPLAY_BYTES_PER_PIXEL);
  for (let i = 3; i < pixels.length; i += REPLAY_BYTES_PER_PIXEL) pixels[i] = 255;
  return pixels;
}

/** Apply one recorded update to a framebuffer. Out-of-bounds pixels are clipped. */
export function applyReplayUpdate(
  target: Uint8ClampedArray,
  width: number,
  height: number,
  update: ReplayUpdate,
  bytes: Uint8Array,
): void {
  for (const rect of update.rects) {
    if (rect.width === 0 || rect.height === 0) continue;
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.width);
    const y1 = Math.min(height, rect.y + rect.height);
    if (x0 >= x1 || y0 >= y1) continue;
    if (rect.encoding === 1) {
      const sx = (rect.sourceX ?? 0) + (x0 - rect.x);
      const sy = (rect.sourceY ?? 0) + (y0 - rect.y);
      for (let y = y0; y < y1; y++) {
        const dest = (y * width + x0) * REPLAY_BYTES_PER_PIXEL;
        const src = ((sy + (y - y0)) * width + sx) * REPLAY_BYTES_PER_PIXEL;
        if (src < 0 || src + (x1 - x0) * REPLAY_BYTES_PER_PIXEL > target.length) continue;
        target.copyWithin(dest, src, src + (x1 - x0) * REPLAY_BYTES_PER_PIXEL);
      }
      continue;
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const source = rect.offset + ((y - rect.y) * rect.width + (x - rect.x)) * REPLAY_BYTES_PER_PIXEL;
        const dest = (y * width + x) * REPLAY_BYTES_PER_PIXEL;
        // RFB 32bpp little-endian pixels are stored as blue, green, red, pad.
        target[dest] = bytes[source + 2];
        target[dest + 1] = bytes[source + 1];
        target[dest + 2] = bytes[source];
        target[dest + 3] = 255;
      }
    }
  }
}
