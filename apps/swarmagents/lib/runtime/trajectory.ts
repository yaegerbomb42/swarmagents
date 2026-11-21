/** Best-effort capture of one run's telemetry and final report as JSONL. */

import fs from "node:fs";
import path from "node:path";
import { getRunsDir, RUN_ID_RE } from "../telemetry/paths";
import type { SequencedEvent, TelemetryBus } from "../telemetry/bus";
import { readRunReport } from "./run-report";
import type { RunReport } from "./run-report-types";

export const TRAJECTORY_CAPTURE_ENV = "SWARM_TRAJECTORY_CAPTURE";
export const MAX_TRAJECTORY_BYTES = 5 * 1024 * 1024;
const REPORT_WAIT_MS = 120_000;
const TRIM_HEADROOM_BYTES = 128 * 1024;

type TrajectoryRow =
  | { kind: "owner"; userId: string }
  | { kind: "event"; event: SequencedEvent }
  | { kind: "truncated"; droppedCount: number; throughSeq: number }
  | { kind: "report"; report: RunReport; truncated?: boolean };

interface CaptureState {
  runId: string;
  userId: string;
  runsDir: string;
  rows: TrajectoryRow[];
  bytes: number;
  lastSeq: number;
  droppedCount: number;
  throughSeq: number;
  reportWritten: boolean;
  detached: boolean;
  unsubscribe?: () => void;
}

const active = new WeakMap<TelemetryBus, Map<string, CaptureState>>();

export function trajectoryCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TRAJECTORY_CAPTURE_ENV]?.trim() === "1";
}

export function trajectoryFile(runsDir: string, runId: string): string {
  return path.join(runsDir, "reports", runId, "trajectory.jsonl");
}

function rowBytes(rows: readonly TrajectoryRow[]): number {
  return rows.reduce((bytes, row) => bytes + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"), 0);
}

function lineBytes(row: TrajectoryRow): number {
  return Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8");
}

function parseRows(text: string): TrajectoryRow[] {
  const rows: TrajectoryRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as TrajectoryRow;
      if (value && typeof value === "object" && ["owner", "event", "truncated", "report"].includes(value.kind)) {
        rows.push(value);
      }
    } catch {
      // Ignore a torn final line and keep capturing from the valid prefix.
    }
  }
  return rows;
}

function loadState(runId: string, userId: string, runsDir: string): CaptureState {
  let rows: TrajectoryRow[] = [];
  try {
    rows = parseRows(fs.readFileSync(trajectoryFile(runsDir, runId), "utf8"));
  } catch {
    // A new capture starts with an owner record.
  }
  const owner = rows.find((row): row is Extract<TrajectoryRow, { kind: "owner" }> => row.kind === "owner");
  if (!owner || owner.userId !== userId) rows = [{ kind: "owner", userId }];
  const priorMarker = rows.find((row): row is Extract<TrajectoryRow, { kind: "truncated" }> => row.kind === "truncated");
  const eventRows = rows.filter((row): row is Extract<TrajectoryRow, { kind: "event" }> => row.kind === "event");
  return {
    runId,
    userId,
    runsDir,
    rows,
    bytes: rowBytes(rows),
    lastSeq: eventRows.reduce((seq, row) => Math.max(seq, row.event.seq), 0),
    droppedCount: priorMarker?.droppedCount ?? 0,
    throughSeq: priorMarker?.throughSeq ?? 0,
    reportWritten: rows.some((row) => row.kind === "report"),
    detached: false,
  };
}

function persist(state: CaptureState): void {
  const file = trajectoryFile(state.runsDir, state.runId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, state.rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  } catch (error) {
    // Recording is opt-in and must never fail a run.
    console.error(`[trajectory] could not write record for ${state.runId}:`, error);
  }
}

function trimToCap(state: CaptureState, reserveBytes = 0): boolean {
  let changed = false;
  const targetBytes = Math.max(0, MAX_TRAJECTORY_BYTES - TRIM_HEADROOM_BYTES - reserveBytes);
  while (state.bytes + reserveBytes > targetBytes) {
    const index = state.rows.findIndex((row) => row.kind === "event");
    if (index < 0) break;
    const [removed] = state.rows.splice(index, 1) as [Extract<TrajectoryRow, { kind: "event" }>];
    state.bytes -= lineBytes(removed);
    state.droppedCount += 1;
    state.throughSeq = Math.max(state.throughSeq, removed.event.seq);
    const markerIndex = state.rows.findIndex((row) => row.kind === "truncated");
    const marker: TrajectoryRow = { kind: "truncated", droppedCount: state.droppedCount, throughSeq: state.throughSeq };
    if (markerIndex >= 0) {
      state.bytes -= lineBytes(state.rows[markerIndex]!);
      state.rows[markerIndex] = marker;
    } else state.rows.splice(1, 0, marker);
    state.bytes += lineBytes(marker);
    changed = true;
  }
  return changed;
}

function appendRow(state: CaptureState, row: TrajectoryRow): void {
  state.rows.push(row);
  state.bytes += lineBytes(row);
  if (trimToCap(state)) persist(state);
  else {
    try {
      fs.appendFileSync(trajectoryFile(state.runsDir, state.runId), `${JSON.stringify(row)}\n`, "utf8");
    } catch (error) {
      console.error(`[trajectory] could not append record for ${state.runId}:`, error);
    }
  }
}

function appendEvent(state: CaptureState, event: SequencedEvent): void {
  if (event.seq <= state.lastSeq) return;
  state.lastSeq = event.seq;
  appendRow(state, { kind: "event", event });
}

function compactReport(report: RunReport): RunReport {
  return {
    runId: report.runId,
    userId: report.userId,
    status: report.status,
    prompt: report.prompt.slice(0, 2_000),
    createdAt: report.createdAt,
    finishedAt: report.finishedAt,
    finalText: report.finalText?.slice(0, 4_000),
    couldNotDo: report.couldNotDo.slice(0, 20).map((text) => text.slice(0, 1_000)),
    steps: [],
    artifacts: [],
    shots: [],
    meta: {
      ...report.meta,
      providers: report.meta.providers.slice(0, 20).map((provider) => provider.slice(0, 256)),
      model: report.meta.model?.slice(0, 256),
      vmImage: report.meta.vmImage?.slice(0, 256),
      verification: undefined,
    },
  };
}

async function appendFinalReport(state: CaptureState): Promise<void> {
  const deadline = Date.now() + REPORT_WAIT_MS;
  while (!state.detached && Date.now() < deadline) {
    const report = readRunReport(state.runId, state.runsDir);
    if (report) {
      const row: TrajectoryRow = { kind: "report", report };
      if (trimToCap(state, lineBytes(row))) persist(state);
      const fullRow: TrajectoryRow = { kind: "report", report };
      if (state.bytes + lineBytes(fullRow) <= MAX_TRAJECTORY_BYTES) appendRow(state, fullRow);
      else appendRow(state, { kind: "report", report: compactReport(report), truncated: true });
      state.reportWritten = true;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
}

/** Attach to the existing telemetry stream. Disabled unless explicitly opted in. */
export function attachRunTrajectory(
  runId: string,
  userId: string,
  bus: TelemetryBus,
  options: { enabled?: boolean; runsDir?: string | null } = {},
): () => void {
  if (!(options.enabled ?? trajectoryCaptureEnabled()) || !RUN_ID_RE.test(runId) || !userId) return () => {};
  const runsDir = options.runsDir === undefined ? getRunsDir() : options.runsDir;
  if (!runsDir) return () => {};

  let busRuns = active.get(bus);
  if (!busRuns) {
    busRuns = new Map();
    active.set(bus, busRuns);
  }
  if (busRuns.has(runId)) return () => {};
  const state = loadState(runId, userId, runsDir);
  busRuns.set(runId, state);
  persist(state);

  const detach = () => {
    if (state.detached) return;
    state.detached = true;
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    busRuns?.delete(runId);
  };
  state.unsubscribe = bus.subscribe(runId, 0, (event) => {
    try {
      appendEvent(state, event);
      if (!state.reportWritten && ["run.finished", "run.error", "run.cancelled"].includes(event.type)) {
        void appendFinalReport(state)
          .catch((error) => {
            console.error(`[trajectory] could not attach final report for ${runId}:`, error);
          })
          .finally(detach);
      }
    } catch (error) {
      console.error(`[trajectory] could not capture ${runId}:`, error);
    }
  });
  return detach;
}

/** Read a validated JSONL record and the owner recorded in its first row. */
export function readRunTrajectory(
  runId: string,
  runsDir: string | null = getRunsDir(),
): { userId: string; contents: string } | null {
  if (!runsDir || !RUN_ID_RE.test(runId)) return null;
  try {
    const contents = fs.readFileSync(trajectoryFile(runsDir, runId), "utf8");
    const first = parseRows(contents)[0];
    if (!first || first.kind !== "owner" || !first.userId) return null;
    return { userId: first.userId, contents };
  } catch {
    return null;
  }
}
