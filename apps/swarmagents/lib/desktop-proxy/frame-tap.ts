/**
 * FrameTap — damage-region differencing + keyframe capture over the live
 * desktop stream (live-computer port spec, Task B).
 *
 * The bridge splices raw RFB bytes without decoding pixels. The existing
 * RfbServerDecoder only *frames* server messages (it yields complete,
 * still-encoded messages — no pixel decoding), and only Raw (0) and
 * CopyRect (1) framebuffer encodings are frameable. So the tap owns a
 * framebuffer compositor: it parses the rectangles out of each framed
 * FramebufferUpdate, blits them into a shadow framebuffer, and periodically
 * diffs the shadow against the last diffed frame with computeDamageRegions.
 * Significant damage (or a forced capture, or a long quiet interval with
 * any change) encodes the shadow as a JPEG keyframe into the bounded
 * KeyframeStore.
 *
 * Contracts:
 * - Never throws. Any framing/compositing/encoding failure disables the tap
 *   for the rest of the session (see `disableReason`); the live stream is
 *   never affected. This mirrors the FrameRecorder contract.
 * - Never blocks the splice beyond bounded per-call work: rect blits are
 *   memcpy-speed and always applied (the shadow must stay correct), while
 *   the expensive diff + JPEG encode is throttled (default ≤10/s). Frames
 *   whose diff is throttled away are counted in `stats.diffsDropped`.
 * - Pixel format: 32bpp true-color as advertised by the proxy's ServerInit
 *   (shifts R=16/G=8/B=0, little-endian → B,G,R,X byte order). Damage
 *   detection is channel-order agnostic; JPEG encoding and latestFrame()
 *   convert to RGBA. Override with `channelOrder` if an upstream ever
 *   serves a different layout.
 * - Encodings other than Raw/CopyRect (Tight, ZRLE, …) cannot be framed by
 *   RfbServerDecoder — the tap disables itself, exactly like frame
 *   recording does today.
 */

import { RfbServerDecoder, RfbServerUnsupportedError } from "./rfb-server";
import { computeDamageRegions, type DiffResult } from "./takeover/diff";
import {
  KeyframeStore,
  type KeyframeStoreOptions,
  type StoredKeyframe,
} from "./takeover/keyframe-store";
import type { CaptionFrame } from "./takeover/types";
import { encodeJpeg } from "./jpeg-encode";

const TYPE_FRAMEBUFFER_UPDATE = 0;
const ENCODING_RAW = 0;
const ENCODING_COPY_RECT = 1;
const RECT_HEADER_BYTES = 12;
const BYTES_PER_PIXEL = 4;

export interface FrameTapOptions {
  /** Keyframe store to fill. Default: a new store with `storeOptions`. */
  store?: KeyframeStore;
  /** Store caps when `store` is not supplied. */
  storeOptions?: KeyframeStoreOptions;
  /** Changed-tile ratio at/above which a keyframe is captured. Default 0.02. */
  keyframeChangedRatio?: number;
  /**
   * Capture a keyframe when this long has passed since the last stored one
   * and the frame changed at all. Default 30_000.
   */
  keyframeIntervalMs?: number;
  /** Minimum interval between diffs (throttle). Default 100 (≤10/s). */
  minDiffIntervalMs?: number;
  /** JPEG quality 1..100. Default 75. */
  jpegQuality?: number;
  /** Wire byte order per pixel. Default "bgra" (proxy ServerInit format). */
  channelOrder?: "bgra" | "rgba";
  /** Activity label stamped on keyframes. Default "desktop". */
  activity?: string | (() => string);
  /** Called after each diff that found damage. Guarded; never throws out. */
  onDamage?: (
    result: DiffResult,
    meta: { width: number; height: number; timestamp: number },
  ) => void;
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface FrameTapStats {
  /** Upstream payloads fed to the tap. */
  payloadsFed: number;
  /** FramebufferUpdate messages composited. */
  framesApplied: number;
  /** Rectangles blitted into the shadow. */
  rectsApplied: number;
  /** Diffs actually computed. */
  diffsRun: number;
  /** Diffs skipped by the throttle (frames still blitted). */
  diffsDropped: number;
  /** Keyframes accepted by the store. */
  keyframesStored: number;
}

export class FrameTap {
  readonly keyframes: KeyframeStore;
  readonly stats: FrameTapStats = {
    payloadsFed: 0,
    framesApplied: 0,
    rectsApplied: 0,
    diffsRun: 0,
    diffsDropped: 0,
    keyframesStored: 0,
  };

  private readonly decoder = new RfbServerDecoder(BYTES_PER_PIXEL);
  private readonly keyframeChangedRatio: number;
  private readonly keyframeIntervalMs: number;
  private readonly minDiffIntervalMs: number;
  private readonly jpegQuality: number;
  private readonly channelOrder: "bgra" | "rgba";
  private readonly activity: string | (() => string);
  private readonly onDamage?: FrameTapOptions["onDamage"];
  private readonly now: () => number;

  private width = 0;
  private height = 0;
  private shadow: Uint8Array | null = null;
  private prevDiffed: Uint8Array | null = null;
  private hasFrame = false;
  private lastDiffAt = 0;
  private lastStoredAt = 0;
  private closed = false;
  private disabledReason: string | null = null;

  constructor(options: FrameTapOptions = {}) {
    this.keyframes = options.store ?? new KeyframeStore(options.storeOptions);
    this.keyframeChangedRatio = options.keyframeChangedRatio ?? 0.02;
    this.keyframeIntervalMs = options.keyframeIntervalMs ?? 30_000;
    this.minDiffIntervalMs = options.minDiffIntervalMs ?? 100;
    this.jpegQuality = options.jpegQuality ?? 75;
    this.channelOrder = options.channelOrder ?? "bgra";
    this.activity = options.activity ?? "desktop";
    this.onDamage = options.onDamage;
    this.now = options.now ?? Date.now;
  }

  /** True once a failure disabled the tap (it will never feed again). */
  get disabled(): boolean {
    return this.disabledReason !== null;
  }

  /** Why the tap disabled itself, or null while healthy. */
  get disableReason(): string | null {
    return this.disabledReason;
  }

  /**
   * Set (or change) the framebuffer size. A size change resets the shadow:
   * the next frame diffs as a full-frame change. Called by the bridge when
   * the upstream ServerInit lands.
   */
  setFramebufferSize(width: number, height: number): void {
    if (this.closed || this.disabled) return;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return;
    }
    if (width === this.width && height === this.height && this.shadow) return;
    this.width = width;
    this.height = height;
    this.shadow = new Uint8Array(width * height * BYTES_PER_PIXEL);
    this.prevDiffed = null;
    this.hasFrame = false;
  }

  /**
   * Feed one chunk of the upstream server→client RFB byte stream (the same
   * payloads the bridge forwards to the browser). Never throws.
   */
  feed(payload: Buffer): void {
    if (this.closed || this.disabled || payload.length === 0) return;
    this.stats.payloadsFed++;
    try {
      for (const frame of this.decoder.push(payload)) {
        if (frame.type !== TYPE_FRAMEBUFFER_UPDATE) continue;
        // Size not set yet (no ServerInit seen): the decoder still consumes
        // the bytes so framing stays in sync, but nothing is composited or
        // counted until setFramebufferSize allocates the shadow.
        if (!this.shadow) continue;
        this.applyFramebufferUpdate(frame.raw);
        this.stats.framesApplied++;
        this.maybeDiff(false);
      }
    } catch (err) {
      this.disable(
        err instanceof RfbServerUnsupportedError
          ? `unsupported RFB stream: ${err.message}`
          : `frame tap failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Capture a keyframe from the current shadow immediately (e.g. at a
   * takeover transition), bypassing the ratio threshold and the store's
   * min-interval. Returns the stored keyframe, or null when there is no
   * frame yet / the tap is disabled / the store rejected it.
   */
  forceKeyframe(activity?: string): StoredKeyframe | null {
    if (this.closed || this.disabled || !this.hasFrame || !this.shadow) return null;
    try {
      return this.storeKeyframe(activity ?? this.activityLabel(), true);
    } catch (err) {
      this.disable(`keyframe encode failure: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * The latest composited frame as RGBA (a copy), for the handback
   * summarizer's captioner. Null until the first rectangle lands.
   */
  latestFrame(): CaptionFrame | null {
    if (!this.hasFrame || !this.shadow) return null;
    return { width: this.width, height: this.height, rgba: this.toRgba(this.shadow) };
  }

  /** Stop accepting feeds. The store stays readable. Idempotent. */
  close(): void {
    this.closed = true;
  }

  // --- compositing ---------------------------------------------------------

  private applyFramebufferUpdate(raw: Buffer): void {
    if (!this.shadow) return; // size not set yet; nothing to composite into
    if (raw.length < 4) throw new Error("FramebufferUpdate shorter than its header");
    const rects = raw.readUInt16BE(2);
    let offset = 4;
    for (let i = 0; i < rects; i++) {
      if (offset + RECT_HEADER_BYTES > raw.length) {
        throw new Error("FramebufferUpdate rect header overruns message");
      }
      const x = raw.readUInt16BE(offset);
      const y = raw.readUInt16BE(offset + 2);
      const w = raw.readUInt16BE(offset + 4);
      const h = raw.readUInt16BE(offset + 6);
      const encoding = raw.readInt32BE(offset + 8);
      offset += RECT_HEADER_BYTES;
      if (encoding === ENCODING_RAW) {
        const bytes = w * h * BYTES_PER_PIXEL;
        if (offset + bytes > raw.length) {
          throw new Error("Raw rect payload overruns message");
        }
        this.blitRaw(raw.subarray(offset, offset + bytes), x, y, w, h);
        offset += bytes;
      } else if (encoding === ENCODING_COPY_RECT) {
        if (offset + 4 > raw.length) {
          throw new Error("CopyRect payload overruns message");
        }
        const srcX = raw.readUInt16BE(offset);
        const srcY = raw.readUInt16BE(offset + 2);
        offset += 4;
        this.blitCopy(srcX, srcY, x, y, w, h);
      } else {
        // The decoder only frames Raw/CopyRect, so this is unreachable in
        // practice; fail the tap rather than guess at a size.
        throw new Error(`unsupported framebuffer encoding ${encoding}`);
      }
      this.stats.rectsApplied++;
    }
    if (rects > 0) this.hasFrame = true;
  }

  /** Copy a Raw rect's rows into the shadow, clipped to the framebuffer. */
  private blitRaw(pixels: Buffer, x: number, y: number, w: number, h: number): void {
    const shadow = this.shadow!;
    const clipW = Math.min(w, this.width - x);
    const clipH = Math.min(h, this.height - y);
    if (clipW <= 0 || clipH <= 0) return;
    const srcStride = w * BYTES_PER_PIXEL;
    const dstStride = this.width * BYTES_PER_PIXEL;
    for (let row = 0; row < clipH; row++) {
      const src = pixels.subarray(row * srcStride, row * srcStride + clipW * BYTES_PER_PIXEL);
      shadow.set(src, (y + row) * dstStride + x * BYTES_PER_PIXEL);
    }
  }

  /** CopyRect: snapshot the source rect first so overlaps copy correctly. */
  private blitCopy(srcX: number, srcY: number, x: number, y: number, w: number, h: number): void {
    const shadow = this.shadow!;
    const clipW = Math.min(w, this.width - x, this.width - srcX);
    const clipH = Math.min(h, this.height - y, this.height - srcY);
    if (clipW <= 0 || clipH <= 0) return;
    const stride = this.width * BYTES_PER_PIXEL;
    const rowBytes = clipW * BYTES_PER_PIXEL;
    const snapshot = new Uint8Array(rowBytes * clipH);
    for (let row = 0; row < clipH; row++) {
      snapshot.set(
        shadow.subarray((srcY + row) * stride + srcX * BYTES_PER_PIXEL, (srcY + row) * stride + srcX * BYTES_PER_PIXEL + rowBytes),
        row * rowBytes,
      );
    }
    for (let row = 0; row < clipH; row++) {
      shadow.set(
        snapshot.subarray(row * rowBytes, (row + 1) * rowBytes),
        (y + row) * stride + x * BYTES_PER_PIXEL,
      );
    }
  }

  // --- diffing + keyframes -------------------------------------------------

  private maybeDiff(force: boolean): void {
    if (!this.shadow || !this.hasFrame) return;
    const now = this.now();
    if (!force && now - this.lastDiffAt < this.minDiffIntervalMs) {
      this.stats.diffsDropped++;
      return;
    }
    this.lastDiffAt = now;
    this.stats.diffsRun++;
    const result = computeDamageRegions(this.prevDiffed, this.shadow, this.width, this.height);
    this.prevDiffed = new Uint8Array(this.shadow);
    if (!result.changed) return;
    if (this.onDamage) {
      try {
        this.onDamage(result, { width: this.width, height: this.height, timestamp: now });
      } catch {
        /* damage sink must not break the tap */
      }
    }
    const significant = result.changedRatio >= this.keyframeChangedRatio;
    const intervalDue = now - this.lastStoredAt >= this.keyframeIntervalMs;
    if (significant || intervalDue) {
      this.storeKeyframe(this.activityLabel(), false);
    }
  }

  private storeKeyframe(activity: string, force: boolean): StoredKeyframe | null {
    const now = this.now();
    const jpeg = encodeJpeg(this.toRgba(this.shadow!), this.width, this.height, {
      quality: this.jpegQuality,
    });
    const stored = this.keyframes.maybeStore(jpeg, this.width, this.height, activity, now, force);
    if (stored) {
      this.stats.keyframesStored++;
      this.lastStoredAt = now;
    }
    return stored;
  }

  /** Convert the shadow (wire order) to a fresh RGBA buffer. */
  private toRgba(shadow: Uint8Array): Uint8Array {
    if (this.channelOrder === "rgba") return new Uint8Array(shadow);
    const out = new Uint8Array(shadow.length);
    for (let i = 0; i < shadow.length; i += 4) {
      out[i] = shadow[i + 2]!; // R <- wire byte 2
      out[i + 1] = shadow[i + 1]!; // G
      out[i + 2] = shadow[i]!; // B <- wire byte 0
      out[i + 3] = 255;
    }
    return out;
  }

  private activityLabel(): string {
    try {
      return typeof this.activity === "function" ? this.activity() : this.activity;
    } catch {
      return "desktop";
    }
  }

  private disable(reason: string): void {
    if (this.disabledReason === null) this.disabledReason = reason;
  }
}
