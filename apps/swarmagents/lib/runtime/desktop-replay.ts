/**
 * Run-replay bridge between the desktop proxy's frame recorder and run
 * reports. The proxy writes one capped `frames-<runId>-<sessionId>.rfb` file
 * per viewer session that watched an active run; at finalize time the reporter
 * concatenates those files into the run's report directory and records their
 * metadata in `report.json`. Nothing here throws into the run path: a missing
 * or unreadable recording simply means the report has no replay.
 */

import fs from "node:fs";
import path from "node:path";
import { DESKTOP_FRAME_HEIGHT, DESKTOP_FRAME_WIDTH } from "../client/desktopConfig";
import { FRAME_RECORDING_CAP_BYTES } from "../desktop-proxy/frame-recorder";
import { DESKTOP_REPLAY_FILE, type ReportReplayMeta } from "./run-report-types";

/** Name of one session's recording, keyed to the run it is replaying. */
export function desktopRecordingName(runId: string, sessionId: number): string {
  return `frames-${runId}-${sessionId}.rfb`;
}

/**
 * Directory the desktop proxy records run-tagged viewer sessions into, and
 * the one attachDesktopReplay reads from. Both sides must use this helper.
 */
export function desktopReplayDir(runsDir: string): string {
  return path.join(runsDir, "replays");
}

function replaySources(runsDir: string, runId: string): string[] {
  const dir = desktopReplayDir(runsDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^frames-${escaped}-(\\d+)\\.rfb$`);
  return names
    .map((name) => ({ name, session: Number(match.exec(name)?.[1]) }))
    .filter((entry) => Number.isSafeInteger(entry.session))
    .sort((a, b) => a.session - b.session)
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Copy the recorded frames for `runId` into its report directory. Returns the
 * metadata to put on the report, or undefined when no recording was made.
 */
export function attachDesktopReplay(runId: string, runsDir: string | null): ReportReplayMeta | undefined {
  if (!runsDir) return undefined;
  const sources = replaySources(runsDir, runId);
  if (sources.length === 0) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for (const source of sources) {
    try {
      const remaining = FRAME_RECORDING_CAP_BYTES - size;
      if (remaining <= 0) break;
      const bytes = fs.readFileSync(source);
      chunks.push(bytes.subarray(0, remaining));
      size += Math.min(bytes.length, remaining);
    } catch {
      continue;
    }
  }
  if (chunks.length === 0) return undefined;
  const bytes = Buffer.concat(chunks, size);
  try {
    const dir = path.join(runsDir, "reports", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, DESKTOP_REPLAY_FILE), bytes);
  } catch (error) {
    console.error(`[desktop-replay] could not store replay for ${runId}:`, error);
    return undefined;
  }
  // Recordings are owned by this helper once attached; leaving them would let
  // capped 50 MB files pile up forever. An unlink while a viewer is still
  // connected is harmless — its open fd keeps writing to the unlinked inode.
  for (const source of sources) {
    try {
      fs.unlinkSync(source);
    } catch {}
  }
  return {
    file: DESKTOP_REPLAY_FILE,
    mime: "application/octet-stream",
    size: bytes.length,
    width: DESKTOP_FRAME_WIDTH,
    height: DESKTOP_FRAME_HEIGHT,
  };
}
