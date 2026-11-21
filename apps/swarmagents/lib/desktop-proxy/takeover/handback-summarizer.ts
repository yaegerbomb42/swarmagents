import fs from "node:fs";
import path from "node:path";
import type { CaptionFrame, HandbackSummary, InputEvent } from "./types";

/** The only adapter surface the summarizer needs: the focused window title. */
export interface WindowTitleProvider {
  getActiveWindowTitle(): Promise<string>;
}

export type FrameCaptioner = (
  frame: CaptionFrame | null,
  activeWindow: string,
) => Promise<string>;

export interface HandbackSummarizerOptions {
  adapter: WindowTitleProvider;
  watchDirs?: string[];
  maxTokens?: number;
  captioner?: FrameCaptioner;
  windowPollIntervalMs?: number;
}

/**
 * Conservative token estimator (~4 chars/token or ~1.3 tokens/word, whichever is larger).
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const wordEst = Math.ceil(trimmed.split(/\s+/).length * 1.3);
  const charEst = Math.ceil(trimmed.length / 4);
  return Math.max(wordEst, charEst);
}

export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; tokenCount: number } {
  if (estimateTokens(text) <= maxTokens) {
    return { text, tokenCount: estimateTokens(text) };
  }
  const words = text.trim().split(/\s+/);
  let low = 0;
  let high = words.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${words.slice(0, mid).join(" ")}...`;
    if (estimateTokens(candidate) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const truncated = low > 0 ? `${words.slice(0, low).join(" ")}...` : "";
  return { text: truncated, tokenCount: estimateTokens(truncated) };
}

export async function defaultFrameCaptioner(
  frame: CaptionFrame | null,
  activeWindow: string,
): Promise<string> {
  if (!frame) {
    return `Screen focused on "${activeWindow}" (no frame captured).`;
  }
  // Compute average luminance across sampled pixels for a factual, deterministic description.
  let lumSum = 0;
  let samples = 0;
  const step = Math.max(4, Math.floor((frame.width * frame.height) / 500));
  for (let p = 0; p < frame.width * frame.height; p += step) {
    const idx = p * 4;
    const r = frame.rgba[idx] ?? 0;
    const g = frame.rgba[idx + 1] ?? 0;
    const b = frame.rgba[idx + 2] ?? 0;
    lumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    samples++;
  }
  const avgLum = samples > 0 ? Math.round(lumSum / samples) : 0;
  const theme = avgLum < 80 ? "dark-themed" : avgLum > 175 ? "light-themed" : "mid-tone";
  return `${frame.width}x${frame.height} ${theme} display showing "${activeWindow}".`;
}

export class HandbackSummarizer {
  private readonly adapter: WindowTitleProvider;
  private readonly watchDirs: string[];
  private readonly maxTokens: number;
  private readonly captioner: FrameCaptioner;
  private readonly windowPollIntervalMs: number;

  private active = false;
  private startedAt = 0;
  private windowTitles: string[] = [];
  private modifiedFiles = new Set<string>();
  private inputEventsCount = 0;
  private watchers: fs.FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: HandbackSummarizerOptions) {
    this.adapter = options.adapter;
    this.watchDirs = options.watchDirs ?? [];
    this.maxTokens = Math.min(300, options.maxTokens ?? 300);
    this.captioner = options.captioner ?? defaultFrameCaptioner;
    this.windowPollIntervalMs = options.windowPollIntervalMs ?? 500;
  }

  async startTracking(): Promise<void> {
    this.stopTracking();
    this.active = true;
    this.startedAt = Date.now();
    this.windowTitles = [];
    this.modifiedFiles.clear();
    this.inputEventsCount = 0;

    await this.recordCurrentWindow();

    this.pollTimer = setInterval(() => {
      void this.recordCurrentWindow();
    }, this.windowPollIntervalMs);

    for (const dir of this.watchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
          if (filename) {
            const normalized = path.join(path.basename(dir), filename.toString());
            this.modifiedFiles.add(normalized);
          }
        });
        this.watchers.push(watcher);
      } catch {
        // Fallback to non-recursive watch on platforms without recursive fs.watch
        try {
          const watcher = fs.watch(dir, (_eventType, filename) => {
            if (filename) {
              this.modifiedFiles.add(path.join(path.basename(dir), filename.toString()));
            }
          });
          this.watchers.push(watcher);
        } catch {
          // Ignore unreadable watch paths
        }
      }
    }
  }

  recordInput(_event: InputEvent): void {
    if (this.active) {
      this.inputEventsCount += 1;
    }
  }

  /** Allows tests or external file-tracking hooks to register a modified path explicitly. */
  recordModifiedFile(filePath: string): void {
    if (this.active) {
      this.modifiedFiles.add(filePath);
    }
  }

  async finalize(lastFrame: CaptionFrame | null): Promise<HandbackSummary> {
    await this.recordCurrentWindow();
    const durationMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    const windows = [...this.windowTitles];
    const files = [...this.modifiedFiles].sort();
    const inputs = this.inputEventsCount;
    this.stopTracking();

    const activeWindow = windows[windows.length - 1] ?? "Desktop";
    const lastFrameCaption = await this.captioner(lastFrame, activeWindow);

    const parts: string[] = [
      `Human drove for ${(durationMs / 1000).toFixed(1)}s (${inputs} input events).`,
      `Focused windows: ${windows.length > 0 ? windows.join(" -> ") : "none observed"}.`,
      `Modified files: ${files.length > 0 ? files.slice(0, 12).join(", ") : "none"}.`,
      `Last frame: ${lastFrameCaption}`,
    ];

    const rawText = parts.join(" ");
    const { text, tokenCount } = truncateToTokenBudget(rawText, this.maxTokens);

    return {
      text,
      tokenCount,
      windowTitles: windows,
      modifiedFiles: files,
      lastFrameCaption,
      durationMs,
      inputEventsCount: inputs,
      generatedAt: Date.now(),
    };
  }

  stopTracking(): void {
    this.active = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private async recordCurrentWindow(): Promise<void> {
    try {
      const title = await this.adapter.getActiveWindowTitle();
      if (title && this.windowTitles[this.windowTitles.length - 1] !== title) {
        this.windowTitles.push(title);
      }
    } catch {
      // Ignore transient window title errors
    }
  }
}
