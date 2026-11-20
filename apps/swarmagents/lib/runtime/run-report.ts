/**
 * Per-run "Run report": a verifiable receipt created automatically when a run
 * finishes (success, failure or stop).
 *
 * The report reuses the telemetry already emitted to the bus — the source of
 * truth for the timeline — and adds three things the stream alone cannot
 * provide:
 *
 *   - Screenshots: captured at run start, after each desktop computer.action
 *     (sampled to at most MAX_STEP_SHOTS), and at run end. Desktop mode uses
 *     `scrot` inside the VM; headless runs fall back to the run's latest
 *     browser frame. Terminal-only VMs degrade gracefully to text-only.
 *   - Artifacts: a diff of `/workspace` (path, size, mtime) taken at run
 *     start vs run end, so the user can see exactly which files the agent
 *     created or modified.
 *   - A "What I could not do" section derived from failed steps (tool errors,
 *     blocked calls, denied/expired approvals, terminal run errors).
 *
 * Reports live server-side in `<runsDir>/reports/<runId>/` (report.json plus
 * `shots/`), gated by the owner-only routes under
 * app/api/runtime/runs/[id]/report/...
 */

import fs from "node:fs";
import path from "node:path";
import type { SequencedEvent } from "../telemetry/bus";
import { getRunsDir } from "../telemetry/paths";
import { DESKTOP_DISPLAY } from "../vm/docker-driver";
import { WORKSPACE_ROOT } from "../vm/files";
import type { VmManager } from "../vm/manager";
import type { BrowserControl } from "../browser/manager";
import type {
  ReportArtifact,
  ReportCardMeta,
  ReportShotMeta,
  ReportStatus,
  ReportStep,
  RunReport,
} from "./run-report-types";

/** Cap on action screenshots sampled into one report. */
export const MAX_STEP_SHOTS = 30;
/** Hard cap on total screenshots (start + actions + end). */
export const MAX_REPLAY_SHOTS = 32;
/** Cap on artifacts listed in a report. */
export const MAX_ARTIFACTS = 200;
/** Cap on steps in the condensed timeline. */
export const MAX_STEPS = 500;
/** Cap on "could not do" entries. */
export const MAX_COULD_NOT_DO = 20;
/** Max bytes served for one artifact download. */
export const MAX_ARTIFACT_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** mtime tolerance (ms) below which a file counts as unchanged. */
const MTIME_TOLERANCE_MS = 1000;
/** Longest single step text. */
const STEP_TEXT_MAX = 240;
/** Longest merged message step. */
const MESSAGE_STEP_MAX = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// --- timeline steps ---------------------------------------------------------

/**
 * Condense a run's telemetry into readable, ordered steps. Consecutive
 * assistant text merges into one message step; tool calls pair with their
 * result by id; desktop actions, approvals and terminal states map 1:1.
 */
export function buildReportSteps(events: readonly SequencedEvent[]): ReportStep[] {
  const steps: ReportStep[] = [];
  const toolByCallId = new Map<string, ReportStep>();
  const approvals: ReportStep[] = [];

  const push = (kind: ReportStep["kind"], text: string, extra?: Partial<ReportStep>): ReportStep => {
    const step: ReportStep = {
      seq: extra?.seq ?? 0,
      ts: extra?.ts ?? 0,
      kind,
      text: truncate(text, STEP_TEXT_MAX),
      ...extra,
    };
    if (steps.length < MAX_STEPS) steps.push(step);
    return step;
  };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    const field = (name: string): unknown =>
      name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];

    switch (event.type) {
      case "run.started": {
        const model = str(field("model"));
        push("start", model ? `Run started · ${model}` : "Run started", {
          seq: event.seq,
          ts: event.ts,
        });
        break;
      }
      case "assistant.text": {
        const text = str(field("text")) ?? "";
        if (!text) break;
        const last = steps[steps.length - 1];
        if (last && last.kind === "message") {
          // Telemetry seqs are strictly increasing, so consecutive chunks of
          // one assistant message can never share a seq: merge on kind
          // alone, concatenating directly (no injected spaces — the chunks
          // already carry their own spacing).
          last.text = truncate(last.text + text, MESSAGE_STEP_MAX);
        } else {
          push("message", text, { seq: event.seq, ts: event.ts });
        }
        break;
      }
      case "tool.call": {
        const name = str(field("name")) ?? "tool";
        const id = str(field("id"));
        const step = push("tool", `Using ${name}`, { seq: event.seq, ts: event.ts });
        if (id) toolByCallId.set(id, step);
        break;
      }
      case "tool.result": {
        const id = str(field("id"));
        const ok = field("ok") !== false;
        const target = id ? toolByCallId.get(id) : undefined;
        if (target) {
          target.ok = ok;
        } else {
          push("tool", ok ? "Tool succeeded" : "Tool failed", {
            seq: event.seq,
            ts: event.ts,
            ok,
          });
        }
        break;
      }
      case "computer.action": {
        const action = str(field("action"));
        push("desktop", action ?? "Desktop action", { seq: event.seq, ts: event.ts });
        break;
      }
      case "approval.required": {
        const approval = isRecord(data.approval) ? data.approval : data;
        const action = str(approval.action) ?? str(approval.tool) ?? "an action";
        const step = push("approval", `Approval requested · ${action}`, {
          seq: event.seq,
          ts: event.ts,
        });
        approvals.push(step);
        break;
      }
      case "approval.resolved": {
        const verdict = str(field("verdict")) ?? "resolved";
        const approval = approvals.pop();
        if (approval) approval.text = truncate(`${approval.text} · ${verdict}`, STEP_TEXT_MAX);
        break;
      }
      case "approval.timeout": {
        push("approval", "Approval timed out · auto-denied", { seq: event.seq, ts: event.ts });
        break;
      }
      case "tool.blocked": {
        const name = str(field("name")) ?? "tool";
        const reason = str(field("reason"));
        push("blocked", `${name} blocked${reason ? ` · ${reason}` : ""}`, {
          seq: event.seq,
          ts: event.ts,
        });
        break;
      }
      case "role.changed": {
        const to = isRecord(field("to")) ? (field("to") as Record<string, unknown>) : {};
        const name = str(to.name) ?? str(to.id) ?? "another role";
        push("notice", `Switched role → ${name}`, { seq: event.seq, ts: event.ts });
        break;
      }
      case "run.failover": {
        const provider = str(data.provider);
        push("notice", `Failed over to ${provider ?? "another provider"}`, {
          seq: event.seq,
          ts: event.ts,
        });
        break;
      }
      case "run.finished": {
        const exitCode = num(field("exitCode")) ?? 0;
        push("end", `Finished · exit ${exitCode}`, { seq: event.seq, ts: event.ts });
        break;
      }
      case "run.error": {
        const message = str(field("message")) ?? "unknown error";
        push("end", `Error · ${truncate(message, STEP_TEXT_MAX)}`, {
          seq: event.seq,
          ts: event.ts,
        });
        break;
      }
      case "run.cancelled": {
        const reason = str(field("reason"));
        push("end", `Stopped${reason ? ` (${reason})` : ""}`, {
          seq: event.seq,
          ts: event.ts,
        });
        break;
      }
      default:
        break;
    }
  }

  return steps;
}

// --- "what I could not do" --------------------------------------------------

/** Derive the explicit "What I could not do" section from failed steps. */
export function deriveCouldNotDo(events: readonly SequencedEvent[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const callNames = new Map<string, string>();

  const add = (line: string): void => {
    if (!line || seen.has(line) || out.length >= MAX_COULD_NOT_DO) return;
    seen.add(line);
    out.push(line);
  };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    const field = (name: string): unknown =>
      name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];

    switch (event.type) {
      case "tool.call": {
        const id = str(field("id"));
        const name = str(field("name"));
        if (id && name) callNames.set(id, name);
        break;
      }
      case "tool.result": {
        if (field("ok") !== false) break;
        const id = str(field("id"));
        const name = id ? callNames.get(id) : undefined;
        const output = str(field("output"));
        const detail = output ? truncate(output, 200) : undefined;
        add(`${name ?? "Tool"} returned an error${detail ? `: ${detail}` : ""}`);
        break;
      }
      case "tool.blocked": {
        const name = str(field("name")) ?? "tool";
        const reason = str(field("reason")) ?? "denied by policy";
        add(`${name} was blocked: ${reason}`);
        break;
      }
      case "approval.resolved": {
        const verdict = str(field("verdict"));
        if (verdict === "approved") break;
        const approval = isRecord(data.approval) ? data.approval : data;
        const action = str(approval.action) ?? str(approval.tool) ?? "";
        add(action ? `Approval for ${action} was ${verdict}` : `An approval was ${verdict}`);
        break;
      }
      case "approval.timeout": {
        add("An approval request timed out and was auto-denied");
        break;
      }
      case "run.error": {
        const message = str(field("message"));
        if (message) add(message);
        break;
      }
      default:
        break;
    }
  }

  return out;
}

// --- workspace artifact diffing --------------------------------------------

export interface WorkspaceEntry {
  size: number;
  mtimeMs: number;
}

/** Parse `find ... -printf "%p\0%s\0%T@\0"` output into a path -> entry map. */
export function parseFindListing(text: string): Map<string, WorkspaceEntry> {
  const out = new Map<string, WorkspaceEntry>();
  const fields = text.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, rawSize, rawMtime] = fields.slice(i, i + 3);
    if (!file) continue;
    const size = Number(rawSize);
    const seconds = Number(rawMtime);
    if (!Number.isFinite(size) || !Number.isFinite(seconds)) continue;
    out.set(file, { size, mtimeMs: Math.round(seconds * 1000) });
  }
  return out;
}

/** Recursively list files under /workspace (path, size, mtime). */
export async function listWorkspaceFiles(
  vm: VmManager,
  userId: string,
): Promise<Map<string, WorkspaceEntry>> {
  const chunks: Buffer[] = [];
  try {
    const res = await vm.exec(
      userId,
      [
        "find",
        WORKSPACE_ROOT,
        "-type",
        "f",
        "!",
        "-path",
        `${WORKSPACE_ROOT}/.swarm/*`,
        "-printf",
        "%p\0%s\0%T@\0",
      ],
      {
        timeoutMs: 30_000,
        onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
        onStderr: () => {},
      },
    );
    if (res.exitCode !== 0) return new Map();
  } catch {
    return new Map();
  }
  return parseFindListing(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Diff a start-of-run workspace listing against the end-of-run listing.
 * Returns files created (new path) or modified (size or mtime changed) during
 * the run, sorted by path, capped at MAX_ARTIFACTS.
 */
export function diffWorkspaceLists(
  before: ReadonlyMap<string, WorkspaceEntry> | null,
  after: ReadonlyMap<string, WorkspaceEntry>,
): ReportArtifact[] {
  if (!before) return [];
  const artifacts: ReportArtifact[] = [];
  for (const [file, entry] of after) {
    const prev = before.get(file);
    const rel = file === WORKSPACE_ROOT ? file : file.slice(WORKSPACE_ROOT.length + 1);
    if (!prev) {
      artifacts.push({ path: file, rel, size: entry.size, mtimeMs: entry.mtimeMs, change: "created" });
    } else if (prev.size !== entry.size || Math.abs(prev.mtimeMs - entry.mtimeMs) > MTIME_TOLERANCE_MS) {
      artifacts.push({ path: file, rel, size: entry.size, mtimeMs: entry.mtimeMs, change: "modified" });
    }
    if (artifacts.length >= MAX_ARTIFACTS) break;
  }
  artifacts.sort((a, b) => a.rel.localeCompare(b.rel));
  return artifacts;
}

// --- screenshots ------------------------------------------------------------

export interface CapturedShot {
  bytes: Buffer;
  mime: string;
}

/** Capture the desktop display via `scrot` inside the VM, or null. */
export async function captureDesktopScreenshot(
  vm: VmManager,
  userId: string,
): Promise<CapturedShot | null> {
  const tmp = `/tmp/swarm-report-shot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const chunks: Buffer[] = [];
  try {
    const res = await vm.exec(
      userId,
      [
        "sh",
        "-c",
        // The png is removed on every path (success, empty cat, scrot
        // failure) so runs cannot leak one file per screenshot in /tmp.
        `scrot -o "$1" && { cat "$1"; rc=$?; rm -f "$1"; exit $rc; }; rm -f "$1"; exit 1`,
        "sh",
        tmp,
      ],
      {
        timeoutMs: 20_000,
        // scrot needs the desktop display; docker exec does not inherit it.
        env: { DISPLAY: DESKTOP_DISPLAY },
        onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
        onStderr: () => {},
      },
    );
    if (res.exitCode !== 0) return null;
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0 || bytes.length > 6 * 1024 * 1024) return null;
    return { bytes, mime: "image/png" };
  } catch {
    return null;
  }
}

/** Fall back to the run's latest headless browser frame, or null. */
export async function captureBrowserFrame(
  browser: BrowserControl | null,
  runId: string,
): Promise<CapturedShot | null> {
  if (!browser) return null;
  try {
    const frame = await browser.getFrame(runId);
    if (!frame) return null;
    return { bytes: frame.jpeg, mime: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Pick which of n action screenshots to keep so at most `max` survive, spread
 * evenly (always including the first and last).
 */
export function sampleShotIndices(n: number, max: number): number[] {
  if (n <= 0 || max <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const indices: number[] = [0];
  for (let i = 1; i < max - 1; i++) {
    indices.push(Math.round((i * (n - 1)) / (max - 1)));
  }
  if (max > 1) indices.push(n - 1);
  return [...new Set(indices)].sort((a, b) => a - b);
}

// --- report assembly --------------------------------------------------------

export interface ReportInputs {
  runId: string;
  userId: string;
  events: SequencedEvent[];
  createdAt: number;
  finishedAt: number;
  artifacts: ReportArtifact[];
  shots: ReportShotMeta[];
  /** Best-effort extras (can be omitted; defaults derive from events). */
  prompt?: string;
  finalText?: string;
  steps?: ReportStep[];
  couldNotDo?: string[];
  providers?: string[];
  model?: string;
  /** VM image the run executed in (recorded in meta.vmImage). */
  vmImage?: string;
}

/**
 * Assemble the full report document from the persisted events plus the
 * captured screenshots and artifact diff. Pure and synchronous: callers
 * gather the pieces, this folds them.
 */
export function assembleReport(inputs: ReportInputs): RunReport {
  const { events, prompt, finalText, steps, couldNotDo } = inputs;
  const seen = new Set<string>();
  const providers: string[] = [];
  let model: string | undefined;
  let status: ReportStatus = "finished";
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  let numTurns: number | undefined;
  let derivedPrompt: string | undefined;

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    const field = (name: string): unknown =>
      name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];
    switch (event.type) {
      case "run.created": {
        derivedPrompt = str(data.prompt) ?? derivedPrompt;
        break;
      }
      case "run.started": {
        model = str(field("model")) ?? model;
        const provider = str(field("provider"));
        if (provider && !seen.has(provider)) {
          seen.add(provider);
          providers.push(provider);
        }
        break;
      }
      case "run.failover": {
        const provider = str(data.provider);
        if (provider && !seen.has(provider)) {
          seen.add(provider);
          providers.push(provider);
        }
        break;
      }
      case "run.finished":
        status = "finished";
        costUsd = num(field("costUsd")) ?? costUsd;
        durationMs = num(field("durationMs")) ?? durationMs;
        numTurns = num(field("numTurns")) ?? numTurns;
        break;
      case "run.error":
        status = "error";
        break;
      case "run.cancelled":
        status = "cancelled";
        break;
      default:
        break;
    }
  }

  const meta: ReportCardMeta = {
    status,
    steps: (steps ?? buildReportSteps(events)).length,
    shots: inputs.shots.length,
    artifacts: inputs.artifacts.length,
    durationMs,
    costUsd,
    providers,
    model,
    ...(inputs.vmImage ? { vmImage: inputs.vmImage } : {}),
  };

  return {
    runId: inputs.runId,
    userId: inputs.userId,
    status,
    prompt: prompt ?? derivedPrompt ?? "",
    createdAt: inputs.createdAt,
    finishedAt: inputs.finishedAt,
    finalText,
    couldNotDo: couldNotDo ?? deriveCouldNotDo(events),
    steps: steps ?? buildReportSteps(events),
    artifacts: inputs.artifacts,
    shots: inputs.shots,
    meta,
  };
}

// --- durable store ----------------------------------------------------------

export function reportDir(runsDir: string, runId: string): string {
  return path.join(runsDir, "reports", runId);
}

export function reportFile(runsDir: string, runId: string): string {
  return path.join(reportDir(runsDir, runId), "report.json");
}

export function shotsDir(runsDir: string, runId: string): string {
  return path.join(reportDir(runsDir, runId), "shots");
}

/** Persist a report document (and any shots already written) to disk. */
export function writeRunReport(
  runId: string,
  report: RunReport,
  runsDir: string | null = getRunsDir(),
): void {
  if (!runsDir) return;
  try {
    fs.mkdirSync(reportDir(runsDir, runId), { recursive: true });
    fs.writeFileSync(reportFile(runsDir, runId), JSON.stringify(report, null, 2), "utf8");
  } catch (error) {
    console.error(`[run-report] could not write report for ${runId}:`, error);
  }
}

/** Write one screenshot's bytes under the run's shots directory. */
export function writeShotFile(
  runId: string,
  shot: ReportShotMeta,
  bytes: Buffer,
  runsDir: string | null = getRunsDir(),
): void {
  if (!runsDir) return;
  try {
    fs.mkdirSync(shotsDir(runsDir, runId), { recursive: true });
    fs.writeFileSync(path.join(shotsDir(runsDir, runId), shot.file), bytes);
  } catch (error) {
    console.error(`[run-report] could not write shot for ${runId}:`, error);
  }
}

/** Read a run's report document, or null when none exists. */
export function readRunReport(runId: string, runsDir: string | null = getRunsDir()): RunReport | null {
  if (!runsDir) return null;
  try {
    const text = fs.readFileSync(reportFile(runsDir, runId), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || typeof parsed.runId !== "string" || parsed.runId !== runId) return null;
    return parsed as unknown as RunReport;
  } catch {
    return null;
  }
}

/** Read the compact card meta without loading the full report. */
export function readReportMeta(runId: string, runsDir: string | null = getRunsDir()): ReportCardMeta | null {
  return readRunReport(runId, runsDir)?.meta ?? null;
}

/** Read one stored screenshot's bytes, or null. */
export function readShotBytes(
  runId: string,
  index: number,
  runsDir: string | null = getRunsDir(),
): { bytes: Buffer; mime: string; name: string } | null {
  const report = readRunReport(runId, runsDir);
  if (!report || index < 0 || index >= report.shots.length) return null;
  const shot = report.shots[index];
  // Shot files are server-generated as `NNN.png` / `NNN.jpg`. Reject anything
  // else so a hand-edited report cannot turn this into an arbitrary-file read.
  if (!/^\d{3}\.(png|jpg)$/.test(shot.file)) return null;
  try {
    const bytes = fs.readFileSync(path.join(shotsDir(runsDir!, runId), shot.file));
    return { bytes, mime: shot.mime, name: shot.file };
  } catch {
    return null;
  }
}
