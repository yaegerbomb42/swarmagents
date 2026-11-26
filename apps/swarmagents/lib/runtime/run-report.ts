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
import { sha256Hex } from "../library/proof";
import type { SequencedEvent } from "../telemetry/bus";
import { latestPlanFromEvents, planProgress } from "../run-plan";
import { getRunsDir } from "../telemetry/paths";
import { aggregateRunTokenAccounting } from "../telemetry/run-token-accounting";
import { DESKTOP_DISPLAY } from "../vm/docker-driver";
import { WORKSPACE_ROOT } from "../vm/files";
import type { VmManager } from "../vm/manager";
import type { BrowserControl } from "../browser/manager";
import { classifyCostProvenance, DESKTOP_REPLAY_FILE } from "./run-report-types";
import type {
  ReportArtifact,
  ReportCardMeta,
  ReportReplayMeta,
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

/**
 * Strip inline markdown markers so a timeline step reads as plain text (the
 * timeline has no markdown renderer — a raw "**Created:** `hello.txt`"
 * would show the markers). Only paired markers are stripped, so a literal
 * glob like `**\/*.ts` (no closing marker) survives untouched.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** -> bold
    .replace(/__([^_]+)__/g, "$1") // __bold__ -> bold
    .replace(/`([^`]+)`/g, "$1"); // `code` -> code
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
        // The timeline is plain text: strip the markdown markers instead of
        // showing raw "**Created:** `hello.txt`".
        const clean = stripMarkdown(text);
        if (!clean) break;
        const last = steps[steps.length - 1];
        if (last && last.kind === "message") {
          // Telemetry seqs are strictly increasing, so consecutive chunks of
          // one assistant message can never share a seq: merge on kind
          // alone, concatenating directly (no injected spaces — the chunks
          // already carry their own spacing).
          last.text = truncate(last.text + clean, MESSAGE_STEP_MAX);
        } else {
          push("message", clean, { seq: event.seq, ts: event.ts });
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
  // If the VM was deliberately stopped (e.g. freed for capacity), do not
  // resurrect it just to build the report — there is nothing to list, and
  // re-ensuring would re-commit a VM slot and block a queued successor.
  if (typeof vm.isVmLive === "function" && !vm.isVmLive(userId)) return new Map();
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
        noResurrect: true,
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

/**
 * Hash each artifact's contents at report-build time (receipt).
 *
 * Reads the live file from the VM via `readFileBytes`, capped at `maxBytes`
 * (default `MAX_ARTIFACT_DOWNLOAD_BYTES`, the same cap as artifact
 * downloads). A file that is gone between listing and read — or larger than
 * the cap — is recorded explicitly as `sha256: null, status: "missing"`,
 * never silently omitted. Never throws: every per-file failure degrades to
 * a missing marker so hashing can never fail the report or the run.
 */
export async function hashArtifacts(
  vm: VmManager,
  userId: string,
  artifacts: readonly ReportArtifact[],
  maxBytes: number = MAX_ARTIFACT_DOWNLOAD_BYTES,
): Promise<ReportArtifact[]> {
  // Same policy as listWorkspaceFiles: never resurrect a stopped VM to hash
  // artifacts — every artifact degrades to an unreadable "missing" marker.
  if (typeof vm.isVmLive === "function" && !vm.isVmLive(userId)) {
    return artifacts.map((artifact) => ({ ...artifact, sha256: null, status: "missing" as const }));
  }
  return Promise.all(
    artifacts.map(async (artifact) => {
      if (artifact.size > maxBytes) {
        console.warn(
          `[run-report] skipping hash for ${artifact.rel}: ${artifact.size} bytes exceeds the ${maxBytes} byte cap`,
        );
        return { ...artifact, sha256: null, status: "missing" as const };
      }
      try {
        const file = await vm.readFileBytes(userId, artifact.path, maxBytes, { noResurrect: true });
        if (file.truncated) {
          console.warn(
            `[run-report] skipping hash for ${artifact.rel}: file grew past the ${maxBytes} byte cap`,
          );
          return { ...artifact, sha256: null, status: "missing" as const };
        }
        return { ...artifact, sha256: sha256Hex(file.content), status: "present" as const };
      } catch {
        return { ...artifact, sha256: null, status: "missing" as const };
      }
    }),
  );
}

/** Tool names that write a file (their input carries the path). */
const FILE_WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** The file path a tool-call input targets, if any. */
function toolCallFilePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input.file_path ?? input.path ?? input.file;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Files the run demonstrably wrote, from its own telemetry: Write/Edit/
 * MultiEdit tool calls that did not explicitly fail, whose target is present
 * in the end-of-run workspace listing. This is the fallback when the
 * before/after listing diff misses a file — the start listing is captured
 * asynchronously after `vm.ready` while the agent starts immediately, so a
 * file the agent creates quickly can already be in the "before" baseline
 * (or a listing can fail), and the diff then reports 0 files changed even
 * though the run wrote files. Only files that exist at run end count, so a
 * write that was later reverted or deleted is not reported.
 */
export function deriveArtifactsFromEvents(
  events: readonly SequencedEvent[],
  after: ReadonlyMap<string, WorkspaceEntry>,
  before: ReadonlyMap<string, WorkspaceEntry> | null,
): ReportArtifact[] {
  const calls = new Map<string, { file: string; failed: boolean }>();
  const unkeyed: { file: string; failed: boolean }[] = [];
  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    const field = (name: string): unknown =>
      name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];
    if (event.type === "tool.call") {
      const rawName = str(field("name")) ?? "";
      const name = rawName.split("__").pop() ?? rawName;
      if (!FILE_WRITING_TOOLS.has(name)) continue;
      const file = toolCallFilePath(field("input"));
      if (!file) continue;
      const id = str(field("id"));
      const record = { file, failed: false };
      if (id) calls.set(id, record);
      else unkeyed.push(record);
    } else if (event.type === "tool.result") {
      const id = str(field("id"));
      if (id && calls.has(id) && field("ok") === false) {
        calls.get(id)!.failed = true;
      }
    }
  }
  const artifacts: ReportArtifact[] = [];
  const seen = new Set<string>();
  const consider = (file: string, failed: boolean): void => {
    if (failed) return;
    const abs = file.startsWith("/") ? file : `${WORKSPACE_ROOT}/${file}`;
    const entry = after.get(abs);
    if (!entry) return;
    const rel = abs === WORKSPACE_ROOT ? abs : abs.slice(WORKSPACE_ROOT.length + 1);
    if (seen.has(rel)) return;
    seen.add(rel);
    artifacts.push({
      path: abs,
      rel,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      change: before && before.has(abs) ? "modified" : "created",
    });
  };
  for (const record of calls.values()) consider(record.file, record.failed);
  for (const record of unkeyed) consider(record.file, record.failed);
  artifacts.sort((a, b) => a.rel.localeCompare(b.rel));
  return artifacts.slice(0, MAX_ARTIFACTS);
}

/**
 * Union of the listing-diff artifacts and the telemetry-derived ones, by
 * relative path. The diff wins when both name a file — it compared against
 * the baseline, so its created/modified call is authoritative.
 */
export function mergeArtifacts(
  diffArtifacts: ReportArtifact[],
  toolArtifacts: ReportArtifact[],
): ReportArtifact[] {
  const byRel = new Map<string, ReportArtifact>();
  for (const artifact of diffArtifacts) byRel.set(artifact.rel, artifact);
  for (const artifact of toolArtifacts) {
    if (!byRel.has(artifact.rel)) byRel.set(artifact.rel, artifact);
  }
  const merged = [...byRel.values()];
  merged.sort((a, b) => a.rel.localeCompare(b.rel));
  return merged.slice(0, MAX_ARTIFACTS);
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
  // Never resurrect a stopped VM just to capture a frame.
  if (typeof vm.isVmLive === "function" && !vm.isVmLive(userId)) return null;
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
        noResurrect: true,
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
  /** Frame-recorder replay attached at finalize time, when one exists. */
  replay?: ReportReplayMeta;
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

  // The run's real elapsed time is the wall clock (created → finished). The
  // CLI's inner duration (run.finished durationMs) excludes VM setup and the
  // prompt round-trip, so it disagrees with the run's own "Finished Ns" —
  // prefer the wall clock whenever it is positive.
  const wallClockMs = inputs.finishedAt - inputs.createdAt;
  if (wallClockMs > 0) durationMs = wallClockMs;

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

  // The agent's own plan (TodoWrite), as it stood when the run ended.
  const plan = latestPlanFromEvents(events);
  if (plan) {
    const { done, total } = planProgress(plan);
    meta.plan = { done, total };
  }

  // Per-model token accounting from the same event stream. Gateway
  // (llm.call) totals win for the card numbers; the harness stream's own
  // usage is the fallback for runs that never crossed the gateway.
  const tokenAccounting = aggregateRunTokenAccounting(events);
  if (tokenAccounting) {
    const gatewayTokens = tokenAccounting.totals.inputTokens + tokenAccounting.totals.outputTokens;
    if (gatewayTokens > 0) {
      meta.tokensIn = tokenAccounting.totals.inputTokens;
      meta.tokensOut = tokenAccounting.totals.outputTokens;
    } else if (tokenAccounting.harness) {
      meta.tokensIn = tokenAccounting.harness.inputTokens;
      meta.tokensOut = tokenAccounting.harness.outputTokens;
    }
    // Cost follows the same rule: the gateway fold is the accounting of
    // record for runs that crossed the gateway — each call's stamp is
    // the provider-reported amount where the provider reported one.
    // The run.finished figure already in meta.costUsd is the harness
    // CLI's own estimate (tokens × the CLI's price table, applied even
    // when a BYOK provider served the run), so it is only the fallback
    // for runs the gateway never saw. The provenance recorded alongside
    // describes whichever figure meta ends up carrying — never borrowed
    // from the other derivation.
    if (tokenAccounting.totals.costUsd !== undefined) {
      meta.costUsd = tokenAccounting.totals.costUsd;
      const info = classifyCostProvenance(tokenAccounting.totals);
      if (info) meta.costProvenance = info.provenance;
    }
  }
  if (meta.costProvenance === undefined && meta.costUsd !== undefined && meta.costUsd > 0) {
    // The figure is the run.finished one: the harness CLI's estimate.
    // (A $0 gateway total also lands here with costUsd 0 — no provenance,
    // matching the card's rule that $0 figures stand unlabeled.)
    meta.costProvenance = "estimated";
  }

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
    ...(inputs.replay ? { replay: inputs.replay } : {}),
    meta,
    ...(plan ? { plan: [...plan] } : {}),
    ...(tokenAccounting ? { tokenAccounting } : {}),
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

/** Read a run's stored desktop replay bytes, or null when it has none. */
export function readReplayBytes(
  runId: string,
  runsDir: string | null = getRunsDir(),
): Buffer | null {
  const report = readRunReport(runId, runsDir);
  if (!report?.replay || report.replay.file !== DESKTOP_REPLAY_FILE || !runsDir) return null;
  try {
    return fs.readFileSync(path.join(reportDir(runsDir, runId), DESKTOP_REPLAY_FILE));
  } catch {
    return null;
  }
}
