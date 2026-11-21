import type { KeyframeMeta } from "./types";

export interface StoredKeyframe {
  meta: KeyframeMeta;
  jpeg: Uint8Array;
}

export interface KeyframeStoreOptions {
  /** Retention window in ms (default: 10 minutes) */
  retentionMs?: number;
  /** Minimum interval between stored keyframes in ms (default: 2000ms) */
  minIntervalMs?: number;
  /** Maximum keyframes in memory */
  maxFrames?: number;
}

export class KeyframeStore {
  private readonly retentionMs: number;
  private readonly minIntervalMs: number;
  private readonly maxFrames: number;
  private readonly frames: StoredKeyframe[] = [];
  private seq = 0;
  private lastStoredAt = 0;

  constructor(options: KeyframeStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? 10 * 60 * 1000;
    this.minIntervalMs = options.minIntervalMs ?? 2_000;
    this.maxFrames = options.maxFrames ?? 320;
  }

  maybeStore(
    jpeg: Uint8Array,
    width: number,
    height: number,
    activity: string,
    now = Date.now(),
    force = false,
  ): StoredKeyframe | null {
    if (!force && now - this.lastStoredAt < this.minIntervalMs) {
      return null;
    }

    this.seq += 1;
    const id = `kf_${now}_${this.seq}`;
    const copy = new Uint8Array(jpeg);
    const entry: StoredKeyframe = {
      meta: {
        id,
        timestamp: now,
        width,
        height,
        activity,
        sizeBytes: copy.byteLength,
      },
      jpeg: copy,
    };
    this.frames.push(entry);
    this.lastStoredAt = now;
    this.prune(now);
    return entry;
  }

  listMeta(now = Date.now()): KeyframeMeta[] {
    this.prune(now);
    return this.frames.map((f) => f.meta);
  }

  getById(id: string): StoredKeyframe | undefined {
    return this.frames.find((f) => f.meta.id === id);
  }

  getLatest(): StoredKeyframe | undefined {
    return this.frames.at(-1);
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    while (
      this.frames.length > 0 &&
      (this.frames[0]!.meta.timestamp < cutoff || this.frames.length > this.maxFrames)
    ) {
      this.frames.shift();
    }
  }
}
