/**
 * RunReporter: creates a per-run "Run report" automatically when a run
 * finishes (success, failure or stop).
 *
 * It subscribes to the run's telemetry bus and acts on the events the runtime
 * already emits:
 *
 *   - `vm.ready`  → capture the start screenshot and a `/workspace` listing
 *     snapshot (the diff baseline for artifacts).
 *   - `computer.action` → capture a desktop/browser screenshot (sampled to at
 *     most MAX_STEP_SHOTS), so the replay slideshow tracks what was on screen.
 *   - a terminal event (`run.finished` / `run.error` / `run.cancelled`) →
 *     capture the end screenshot, diff the workspace listing, assemble the
 *     report from the persisted events, and write it to disk.
 *
 * Screenshot capture is best-effort: desktop mode uses `scrot` inside the VM,
 * headless runs fall back to the run's latest browser frame, and terminal-only
 * VMs degrade gracefully to a text-only report. The reporter never throws
 * into the run path — every step is wrapped and logged.
 */

import type { SequencedEvent, TelemetryBus } from "../telemetry/bus";
import { getRunsDir } from "../telemetry/paths";
import { readRunEvents } from "../telemetry/run-log";
import { getBrowserManager, type BrowserControl } from "../browser/manager";
import { telemetryBus } from "../telemetry/bus";
import type { VmManager } from "../vm/manager";
import { pinnedLensForRole, runAutoAudit } from "../lenses/audit";
import type { RunReport } from "./run-report-types";
import {
  MAX_REPLAY_SHOTS,
  MAX_STEP_SHOTS,
  assembleReport,
  captureBrowserFrame,
  captureDesktopScreenshot,
  deriveArtifactsFromEvents,
  diffWorkspaceLists,
  listWorkspaceFiles,
  mergeArtifacts,
  readRunReport,
  writeRunReport,
  writeShotFile,
  type WorkspaceEntry,
} from "./run-report";
import type { ReportShotMeta } from "./run-report-types";

export interface RunReporterOptions {
  vm: VmManager;
  /** Telemetry bus to watch for run events (defaults to the global bus). */
  bus?: TelemetryBus;
  /** Test hook: stub the browser frame fallback. */
  browser?: BrowserControl | null;
  /** Test hook: runs directory resolver (defaults to getRunsDir). */
  runsDir?: () => string | null;
  maxStepShots?: number;
  /** Test hook: override the background auto-audit runner. */
  lensRunner?: typeof runAutoAudit;
}

interface PendingRun {
  runId: string;
  userId: string;
  /** The role that started the run (undefined = legacy un-role'd run). */
  roleId?: string;
  startListing: Map<string, WorkspaceEntry> | null;
  shots: ReportShotMeta[];
  actionShots: number;
  /** Serializes capture/report work per run; never awaited by the bus. */
  chain: Promise<void>;
  done: boolean;
  /** Bus unsubscribe, held so the terminal path can detach (fix: leaked). */
  unsubscribe?: () => void;
}

function shotFile(index: number, mime: string): string {
  const ext = mime === "image/jpeg" ? "jpg" : "png";
  return `${String(index).padStart(3, "0")}.${ext}`;
}

export class RunReporter {
  private readonly vm: VmManager;
  private readonly bus: TelemetryBus;
  private readonly browser: BrowserControl | null;
  private readonly resolveRunsDir: () => string | null;
  private readonly maxStepShots: number;
  private readonly lensRunner: typeof runAutoAudit;
  private readonly pending = new Map<string, PendingRun>();

  constructor(options: RunReporterOptions) {
    this.vm = options.vm;
    this.bus = options.bus ?? telemetryBus;
    this.browser = options.browser === undefined ? getBrowserManager() : options.browser;
    this.resolveRunsDir = options.runsDir ?? getRunsDir;
    this.maxStepShots = Math.max(1, Math.min(options.maxStepShots ?? MAX_STEP_SHOTS, MAX_STEP_SHOTS));
    this.lensRunner = options.lensRunner ?? runAutoAudit;
  }

  /**
   * Start watching a run. Safe to call once per run; returns a detach that
   * stops watching (the reporter also detaches itself at the terminal event).
   * `roleId` is the role that started the run; when it has a lens pinned to it,
   * the reporter auto-audits the run's artifact diff on completion.
   */
  attach(runId: string, userId: string, roleId?: string): () => void {
    if (this.pending.has(runId)) return () => {};
    const state: PendingRun = {
      runId,
      userId,
      roleId: roleId && roleId.length > 0 ? roleId : undefined,
      startListing: null,
      shots: [],
      actionShots: 0,
      chain: Promise.resolve(),
      done: false,
    };
    this.pending.set(runId, state);
    const detach = () => {
      // Detach exactly once: the terminal path below calls this too.
      const unsubscribe = state.unsubscribe;
      state.unsubscribe = undefined;
      unsubscribe?.();
      this.pending.delete(runId);
    };
    const unsubscribe = this.bus.subscribe(runId, 0, (event) => {
      this.handleEvent(state, event);
    });
    state.unsubscribe = unsubscribe;
    return () => {
      detach();
    };
  }

  /** Queue one best-effort step on the run's serialized chain. */
  private queue(state: PendingRun, step: (s: PendingRun) => Promise<void>): void {
    state.chain = state.chain
      .then(() => step(state))
      .catch((error) => {
        console.error(`[run-report] step failed for ${state.runId}:`, error);
      });
  }

  /** Handle one bus event for a watched run. */
  handleEvent(state: PendingRun, event: SequencedEvent): void {
    switch (event.type) {
      case "vm.ready":
        this.queue(state, async (s) => {
          if (s.done) return;
          s.startListing = await listWorkspaceFiles(this.vm, s.userId);
          await this.captureShot(s, 0, "Start");
        });
        break;
      case "computer.action":
        this.queue(state, async (s) => {
          if (s.done || s.actionShots >= this.maxStepShots) return;
          s.actionShots += 1;
          await this.captureShot(s, event.seq, "Action");
        });
        break;
      case "run.finished":
      case "run.error":
      case "run.cancelled":
        this.queue(state, async (s) => {
          if (s.done) return;
          s.done = true;
          await this.captureShot(s, Number.POSITIVE_INFINITY, "End");
          await this.finalize(s);
          this.pending.delete(s.runId);
          // The bus subscription outlives the report unless detached here:
          // without this the closure (and its startListing map) stays alive
          // in the bus for every run the reporter ever watched.
          const unsubscribe = s.unsubscribe;
          s.unsubscribe = undefined;
          unsubscribe?.();
        });
        break;
      default:
        break;
    }
  }

  /** Capture one screenshot and persist it immediately (best-effort). */
  private async captureShot(state: PendingRun, seq: number, label: string): Promise<void> {
    const runsDir = this.resolveRunsDir();
    if (!runsDir) return;
    if (state.shots.length >= MAX_REPLAY_SHOTS) return;
    const shot = await captureDesktopScreenshot(this.vm, state.userId);
    const captured = shot ?? (await captureBrowserFrame(this.browser, state.runId));
    if (!captured) return;
    const index = state.shots.length;
    const meta: ReportShotMeta = {
      file: shotFile(index, captured.mime),
      mime: captured.mime,
      seq,
      ts: Date.now(),
      label,
      size: captured.bytes.length,
    };
    writeShotFile(state.runId, meta, captured.bytes, runsDir);
    state.shots.push(meta);
  }

  /** Assemble and persist the report once the run reached a terminal state. */
  private async finalize(state: PendingRun): Promise<void> {
    const { runId, userId } = state;
    const runsDir = this.resolveRunsDir();
    if (!runsDir) return;
    const events = readRunEvents(runId, runsDir);
    if (events.length === 0) return;
    const createdAt = events[0]?.ts ?? Date.now();
    const finishedAt = events[events.length - 1]?.ts ?? Date.now();
    // Diff against the fresh listing so artifacts reflect the final state.
    // The diff alone can miss files the run wrote (the start listing is
    // captured asynchronously after vm.ready, so a file created quickly can
    // already be in the baseline), so union it with the files the run's own
    // Write/Edit telemetry proves it wrote.
    const after = await listWorkspaceFiles(this.vm, userId);
    const artifacts = mergeArtifacts(
      diffWorkspaceLists(state.startListing, after),
      deriveArtifactsFromEvents(events, after, state.startListing),
    );

    let finalText: string | undefined;
    for (const event of events) {
      if (event.type === "assistant.text") {
        const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
        const text = typeof data.text === "string" ? data.text : undefined;
        if (text) finalText = text;
      }
    }

    const report = assembleReport({
      runId,
      userId,
      events,
      createdAt,
      finishedAt,
      artifacts,
      shots: state.shots,
      finalText,
      // The run's actual VM image, so the proof bundle asserts what ran
      // instead of assuming the default. Undefined for image-less drivers.
      vmImage: this.vm.vmImage(),
    });
    writeRunReport(runId, report, runsDir);
    this.maybeAudit(state, report, runsDir);
  }

  /**
   * When the run's role has a lens pinned to it, audit the run's artifact diff
   * in the background and attach a pass/warn verdict. Best-effort and detached:
   * never blocks or throws into the run path.
   */
  private maybeAudit(state: PendingRun, report: RunReport, runsDir: string): void {
    const lens = pinnedLensForRole(state.userId, state.roleId);
    if (!lens) return;
    if (report.artifacts.length === 0 && !report.finalText) return;
    // Fire-and-forget: tying the audit to the run path is fine, but a provider
    // outage must never fail the report or the run itself.
    void this.lensRunner({ userId: state.userId, runId: state.runId, lens, runsDir }).catch((error) => {
      console.error(`[auto-lens] audit failed for ${state.runId}:`, error);
    });
  }

  /** Whether a report already exists for a run (also used by tests to wait). */
  hasReport(runId: string): boolean {
    return readRunReport(runId, this.resolveRunsDir()) !== null;
  }
}
