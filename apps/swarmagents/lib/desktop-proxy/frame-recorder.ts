/**
 * Opt-in framebuffer recording target. Appends decoded frame bytes to a
 * per-run recording file with hard caps — 50 MB or 10 minutes — after which it
 * stops with a terminal note instead of growing forever. It never throws into
 * the caller: any I/O failure stops recording silently. The recording is
 * append-only and holds frames only (never input/control bytes — that
 * separation is enforced upstream by the RFB decoder that feeds it).
 */

import fs from "node:fs";
import path from "node:path";

export const FRAME_RECORDING_CAP_BYTES = 50 * 1024 * 1024;
export const FRAME_RECORDING_CAP_MS = 10 * 60 * 1000;
/** Written once when a cap stops the recording, so a reader sees why it ends. */
export const FRAME_RECORDING_STOP_NOTE = "--- recording stopped: cap reached ---\n";

export interface FrameRecorderOptions {
  capBytes?: number;
  capMs?: number;
  now?: () => number;
}

export class FrameRecorder {
  private readonly capBytes: number;
  private readonly capMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private bytes = 0;
  private stopped = false;
  private fd: number | null;

  constructor(
    private readonly filePath: string,
    options: FrameRecorderOptions = {},
  ) {
    this.capBytes = options.capBytes ?? FRAME_RECORDING_CAP_BYTES;
    this.capMs = options.capMs ?? FRAME_RECORDING_CAP_MS;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.fd = this.open();
  }

  /** Path to the recording file (for tests/inspection). */
  get file(): string {
    return this.filePath;
  }

  /** True once a cap stopped recording, or the file could not be opened. */
  get active(): boolean {
    return this.fd !== null && !this.stopped;
  }

  /** Append one frame, respecting caps. Never throws. */
  append(frame: Buffer): void {
    if (!this.active) return;
    const nowMs = this.now();
    if (this.bytes + frame.length > this.capBytes || nowMs - this.startedAt >= this.capMs) {
      this.stopWithNote();
      return;
    }
    try {
      fs.writeSync(this.fd!, frame);
      this.bytes += frame.length;
    } catch {
      this.stopWithNote();
    }
  }

  /** Close the recording file. Idempotent, never throws. */
  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    this.stopped = true;
  }

  private open(): number | null {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      return fs.openSync(this.filePath, "a");
    } catch {
      return null;
    }
  }

  private stopWithNote(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, FRAME_RECORDING_STOP_NOTE);
      } catch {}
    }
    this.close();
  }
}
