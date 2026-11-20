/**
 * F4 — "Test-Drive in Isolated Ephemeral Snapshot".
 *
 * From an unreviewed public-library entry the user can run the skill once
 * against their own VM — but only after the VM is snapshotted, so the drive
 * can be kept or rolled back. The drive's server-side record is the source
 * of truth for that decision:
 *
 *   running            -> the drive run is still going (or its report has
 *                         not landed yet). No decision is possible yet.
 *   awaiting-decision  -> the run finished successfully; its diff is on
 *                         display and the user picks keep or roll back.
 *   kept               -> the user kept the post-drive VM state. The
 *                         pre-drive snapshot is left in place.
 *   rolled-back        -> the pre-drive snapshot was restored (user choice,
 *                         a failed run, or superseded by a newer drive).
 *
 * A failed or cancelled drive run auto-rolls back when its status is next
 * read (see the test-drive route): a drive that never succeeded must never
 * leave the VM in the post-drive state. A drive left "awaiting-decision"
 * when the user starts another drive is also rolled back — it was abandoned.
 *
 * The drive run itself is marked, never confused with a normal run:
 *   - its prompt carries a `[test-drive:<publicId>]` marker and the item's
 *     full content inline (the unreviewed item is NOT installed first);
 *   - it starts a fresh session (`freshSession: true`), never continuing the
 *     user's thread;
 *   - this record (and the run's report) is how the UI tells a test-drive
 *     apart from a normal run afterwards.
 *
 * Records live in `<data>/test-drives.json` (0600), next to the public
 * catalog. They contain no secrets — only ids, labels and the item's public
 * name.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  resolveLibraryDataDir,
  type LibraryStoreOptions,
} from "./user-store";
import type { LibraryPayload } from "./types";

export const TEST_DRIVES_FILE = "test-drives.json";
export const MAX_TEST_DRIVES = 200;
/** The drive prompt is capped so the item content cannot blow up the run. */
export const MAX_TEST_DRIVE_ITEM_CHARS = 20_000;

export type TestDriveStatus = "running" | "awaiting-decision" | "kept" | "rolled-back";

/** Why a drive ended up rolled back without the user pressing the button. */
export type TestDriveRollbackReason = "user" | "run-failed" | "superseded" | "start-refused" | "abandoned";

/** A drive left "awaiting-decision" is abandoned once it is older than this. */
export const DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TestDriveRecord {
  id: string;
  /** Owner user id; never sent to another account. */
  userId: string;
  publicId: string;
  publicName: string;
  version: number;
  /** Pre-drive snapshot label (restored on roll back). */
  snapshotLabel: string;
  runId: string;
  status: TestDriveStatus;
  startedAt: number;
  finishedAt?: number;
  rollbackReason?: TestDriveRollbackReason;
  /** Last error, e.g. a restore that failed — surfaced, never swallowed. */
  lastError?: string;
}

interface TestDriveFile {
  schema: string;
  drives: TestDriveRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function testDrivesFilePath(options: LibraryStoreOptions = {}): string {
  return path.join(resolveLibraryDataDir(options), TEST_DRIVES_FILE);
}

function emptyFile(): TestDriveFile {
  return { schema: "swarmagents.test-drives", drives: [] };
}

export function readTestDrives(options: LibraryStoreOptions = {}): TestDriveRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(testDrivesFilePath(options), "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.drives)) return [];
    const drives: TestDriveRecord[] = [];
    for (const entry of parsed.drives) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id !== "string" || typeof entry.userId !== "string") continue;
      if (typeof entry.publicId !== "string" || typeof entry.runId !== "string") continue;
      if (typeof entry.snapshotLabel !== "string" || !entry.snapshotLabel) continue;
      const status = entry.status;
      if (
        status !== "running" &&
        status !== "awaiting-decision" &&
        status !== "kept" &&
        status !== "rolled-back"
      ) {
        continue;
      }
      drives.push({
        id: entry.id,
        userId: entry.userId,
        publicId: entry.publicId,
        publicName: typeof entry.publicName === "string" ? entry.publicName : "",
        version: typeof entry.version === "number" ? entry.version : 1,
        snapshotLabel: entry.snapshotLabel,
        runId: entry.runId,
        status,
        startedAt: typeof entry.startedAt === "number" ? entry.startedAt : Date.now(),
        ...(typeof entry.finishedAt === "number" ? { finishedAt: entry.finishedAt } : {}),
        ...(typeof entry.rollbackReason === "string"
          ? { rollbackReason: entry.rollbackReason as TestDriveRollbackReason }
          : {}),
        ...(typeof entry.lastError === "string" ? { lastError: entry.lastError } : {}),
      });
    }
    return drives;
  } catch {
    return [];
  }
}

function writeTestDrives(drives: TestDriveRecord[], options: LibraryStoreOptions = {}): void {
  const file = testDrivesFilePath(options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const body: TestDriveFile = {
    schema: "swarmagents.test-drives",
    drives: drives.slice(-MAX_TEST_DRIVES),
  };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export function createTestDrive(
  input: Omit<TestDriveRecord, "id" | "status" | "startedAt">,
  options: LibraryStoreOptions = {},
): TestDriveRecord {
  const record: TestDriveRecord = {
    ...input,
    id: `td_${randomBytes(9).toString("base64url")}`,
    status: "running",
    startedAt: Date.now(),
  };
  const drives = readTestDrives(options);
  drives.push(record);
  writeTestDrives(drives, options);
  return record;
}

export function getTestDrive(id: string, options: LibraryStoreOptions = {}): TestDriveRecord | null {
  return readTestDrives(options).find((drive) => drive.id === id) ?? null;
}

export function updateTestDrive(
  id: string,
  patch: Partial<TestDriveRecord>,
  options: LibraryStoreOptions = {},
): TestDriveRecord | null {
  const drives = readTestDrives(options);
  const index = drives.findIndex((drive) => drive.id === id);
  if (index < 0) return null;
  const updated = { ...drives[index], ...patch, id: drives[index].id };
  drives[index] = updated;
  writeTestDrives(drives, options);
  return updated;
}

export function listTestDrivesForUser(
  userId: string,
  options: LibraryStoreOptions = {},
): TestDriveRecord[] {
  return readTestDrives(options)
    .filter((drive) => drive.userId === userId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Snapshot label for a drive (`test-drive-<hex>` — fits the driver charset). */
export function testDriveSnapshotLabel(): string {
  return `test-drive-${randomBytes(4).toString("hex")}`;
}

/** Marker embedded in the drive run's prompt (and visible in its telemetry). */
export function testDriveMarker(publicId: string): string {
  return `[test-drive:${publicId}]`;
}

export interface SweepAbandonedDrivesResult {
  /** Drive ids that were rolled back. */
  swept: string[];
  /** Drives whose roll-back failed — still "awaiting-decision", with lastError set. */
  failed: Array<{ id: string; error: string }>;
}

export interface SweepAbandonedDrivesOptions extends LibraryStoreOptions {
  /** Staleness threshold in ms (default DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS). */
  maxAgeMs?: number;
  /** Clock override for tests. */
  now?: number;
}

/**
 * Roll back stale "awaiting-decision" drives for one user.
 *
 * A drive is stale once it has sat undecided for longer than `maxAgeMs`
 * (anchored at `finishedAt`, when it became awaiting-decision, falling
 * back to `startedAt`). Seven days is deliberately generous: the user may
 * come back days later and still want to choose — the sweep exists so a
 * drive that is never revisited stops pinning the VM's post-drive state
 * forever. Only awaiting-decision drives are swept: a "running" drive may
 * still be going, and "kept"/"rolled-back" drives are already terminal.
 *
 * `restore` performs the VM roll-back (the caller owns the manager). A
 * failure is recorded on the drive (`lastError`) and reported in `failed`,
 * never thrown, so one broken drive cannot block the rest of the sweep.
 * Drives are swept oldest first.
 */
export async function sweepAbandonedDrives(
  userId: string,
  restore: (drive: TestDriveRecord) => Promise<void>,
  options: SweepAbandonedDrivesOptions = {},
): Promise<SweepAbandonedDrivesResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const stale = listTestDrivesForUser(userId, options)
    .filter((drive) => drive.status === "awaiting-decision")
    .filter((drive) => now - (drive.finishedAt ?? drive.startedAt) > maxAgeMs)
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
  const swept: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const drive of stale) {
    try {
      await restore(drive);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateTestDrive(
        drive.id,
        { lastError: `Abandoned-drive roll-back failed (retry it from the drive list): ${message}` },
        options,
      );
      failed.push({ id: drive.id, error: message });
      continue;
    }
    updateTestDrive(
      drive.id,
      { status: "rolled-back", rollbackReason: "abandoned", finishedAt: now },
      options,
    );
    swept.push(drive.id);
  }
  return { swept, failed };
}

function itemContentForPrompt(payload: LibraryPayload): string {
  if (payload.kind === "skill") {
    const extra = payload.files.length
      ? `\n\nSupporting files:\n${payload.files.map((file) => `### ${file.path}\n${file.content}`).join("\n")}`
      : "";
    return `${payload.skillMd}${extra}`;
  }
  if (payload.kind === "tool") {
    return `JavaScript tool (body of async main(args)):\n\`\`\`js\n${payload.code}\n\`\`\`\nInput schema: ${JSON.stringify(payload.inputSchema)}`;
  }
  return `MCP server definition:\n${JSON.stringify(payload, null, 2)}`;
}

/**
 * The prompt a test-drive run starts with. The item's content travels
 * inline — the unreviewed item is deliberately NOT installed into the
 * user's library first — and the marker line names the drive so the run's
 * telemetry can never be mistaken for a normal run.
 */
export function testDrivePrompt(input: {
  publicId: string;
  name: string;
  kind: string;
  version: number;
  payload: LibraryPayload;
  userPrompt?: string;
}): string {
  const content = itemContentForPrompt(input.payload).slice(0, MAX_TEST_DRIVE_ITEM_CHARS);
  const task = input.userPrompt?.trim()
    ? `The user asked you to try it out like this: ${input.userPrompt.trim()}`
    : "Exercise it once end to end on a small, safe example so the user can see what it does.";
  return [
    `${testDriveMarker(input.publicId)} TEST-DRIVE of the unreviewed public-library item "${input.name}" (v${input.version}, ${input.kind}).`,
    "This is an isolated test-drive: the VM was snapshotted before you started, and the user will keep or roll back everything you do afterwards. Do not install anything permanently and do not change anything outside /workspace.",
    task,
    "",
    "--- item under test ---",
    content,
  ].join("\n");
}
