/**
 * Audit log of sensitive actions.
 *
 * Every provider key change, approval decision, snapshot create/restore and
 * login appends one JSON line to `<SWARM_HOME>/audit.jsonl` (falling back to
 * `~/.swarmagents/audit.jsonl` when SWARM_HOME is unset — the same home
 * resolution as the telemetry paths). Each line carries exactly five fields:
 *
 *   { ts, user, action, target, result }
 *
 * `target` is an identifier only — a provider id, approval id, snapshot
 * label or user id. Key material, passwords and tokens are NEVER passed to
 * this module, so they can never land in the log. Writes are best-effort:
 * a failing audit write is logged to stderr and never breaks the action it
 * records.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AuditAction =
  | "provider.add"
  | "provider.delete"
  | "provider.rank"
  | "provider.billing"
  | "provider.effort"
  | "provider.key.add"
  | "provider.key.remove"
  | "provider.key.rotate"
  | "approval.approve"
  | "approval.deny"
  | "approval.expire"
  | "question.answer"
  | "question.expire"
  | "handoff.handback"
  | "handoff.expire"
  | "budget.continue"
  | "budget.stop"
  | "snapshot.create"
  | "snapshot.restore"
  | "snapshot.delete"
  | "login.success"
  | "login.failure"
  | "password.reset.request"
  | "password.reset"
  | "password.change"
  | "email.verify"
  | "email.verify.resend"
  | "signup.botcheck"
  | "session.revoke"
  | "session.logout"
  | "computer.pair"
  | "computer.revoke"
  | "vm.file.upload"
  | "vm.access.denied"
  | "vm.migrate"
  | "desktop.view"
  | "desktop.takeover"
  | "desktop.takeover.request"
  | "desktop.handback"
  | "preview.share.create"
  | "preview.share.revoke"
  | "project.share.create"
  | "project.share.revoke"
  | "agent.deploy"
  | "agent.export"
  | "agent.delete"
  | "library.publish"
  | "library.unpublish"
  | "library.review"
  | "test_drive.start"
  | "test_drive.keep"
  | "test_drive.rollback"
  | "memory.clear"
  | "byoc.pair"
  | "byoc.revoke"
  | "logout"
  | "vault.proxy"
  | "auto-test.run"
  | "connector.connect"
  | "connector.disconnect"
  | "run.compare.remember"
  | "gardener.autopilot"
  | "library.unpublish";

export type AuditResult = "success" | "failure";

/**
 * RFC 5321 path-length cap; keeps audit.jsonl targets bounded.
 */
export const MAX_AUDIT_EMAIL_LEN = 254;

/**
 * Normalize a failed-login email for audit `target`: trim, lowercase, strip
 * C0/C1 controls, and hard-cap length so unauthenticated callers cannot flood
 * audit.jsonl with multi-KB payloads.
 */
export function auditLoginFailureTarget(email: unknown): string {
  if (typeof email !== "string" || !email) return "unknown";
  const cleaned = email
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .toLowerCase()
    .slice(0, MAX_AUDIT_EMAIL_LEN);
  return cleaned || "unknown";
}

export interface AuditEntry {
  ts: string;
  user: string;
  action: AuditAction;
  target: string;
  result: AuditResult;
}

export const AUDIT_FILE_NAME = "audit.jsonl";

/** Default cap for a single GET /api/audit read; callers may ask for less. */
export const DEFAULT_AUDIT_LIMIT = 200;
export const MAX_AUDIT_LIMIT = 1000;

/** Size-based rotation: when audit.jsonl grows past this, it is renamed to audit.jsonl.1. */
export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;

/** Bytes read per backwards chunk; a single read never loads the whole file. */
const AUDIT_READ_CHUNK_BYTES = 64 * 1024;

const MAX_FIELD_LEN = 128;

let override: string | undefined;

/** Point the audit log at a different file (tests). Pass undefined to reset. */
export function configureAuditPath(file: string | undefined): void {
  override = file;
}

// Guarantee strictly-increasing timestamps across writes: several actions can
// otherwise land in the same millisecond, and a timestamp cursor that is shared
// by consecutive entries makes cursor pagination ambiguous (a page boundary can
// fall inside a run of equal timestamps).
let lastRecordedTs = 0;

function nextTs(): string {
  const now = Date.now();
  const ts = now > lastRecordedTs ? now : lastRecordedTs + 1;
  lastRecordedTs = ts;
  return new Date(ts).toISOString();
}

/** Where audit lines are stored. Read per call so a temp SWARM_HOME set by a test takes effect. */
export function getAuditFile(): string {
  if (override !== undefined) return override;
  const home = process.env.SWARM_HOME?.trim();
  if (home) return path.join(home, AUDIT_FILE_NAME);
  return path.join(os.homedir(), ".swarmagents", AUDIT_FILE_NAME);
}

function cleanField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_FIELD_LEN ? trimmed.slice(0, MAX_FIELD_LEN) : trimmed;
}

export interface RecordAuditInput {
  user: string;
  action: AuditAction;
  /** Identifier only (provider id, approval id, snapshot label, user id) — never key material. */
  target: string;
  result: AuditResult;
}

/**
 * Append one audit entry as a JSON line. Never throws: audit persistence
 * must never break the action being recorded.
 */
export function recordAudit(input: RecordAuditInput): void {
  const entry: AuditEntry = {
    ts: nextTs(),
    user: cleanField(input.user) || "unknown",
    action: input.action,
    target: cleanField(input.target),
    result: input.result,
  };
  const line = `${JSON.stringify(entry)}\n`;
  const file = getAuditFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    maybeRotateAuditFile(file);
    // mode 0o600 applies when the file is created; the log holds emails
    // and account activity, so it must never be world-readable.
    fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    ensureAuditFileMode(file);
  } catch (err) {
    console.error(`[audit] could not append to ${file}:`, err);
  }
}

/** Rotation threshold, overridable for tests via SWARM_AUDIT_ROTATE_BYTES. */
function rotateThresholdBytes(): number {
  const raw = process.env.SWARM_AUDIT_ROTATE_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return AUDIT_ROTATE_BYTES;
}

/** Size-based rotation, best-effort: oversize audit.jsonl becomes audit.jsonl.1. */
function maybeRotateAuditFile(file: string): void {
  try {
    if (fs.statSync(file).size < rotateThresholdBytes()) return;
    const rotated = `${file}.1`;
    try {
      fs.unlinkSync(rotated);
    } catch {
      // No previous rotation to replace; the rename below fails closed.
    }
    fs.renameSync(file, rotated);
  } catch {
    // Rotation must never break the audit write that follows.
  }
}

/** Tighten a pre-existing audit file to 0o600 (best-effort). */
function ensureAuditFileMode(file: string): void {
  try {
    if (fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort: the entry is already written.
  }
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.ts === "string" &&
    typeof e.user === "string" &&
    typeof e.action === "string" &&
    typeof e.target === "string" &&
    (e.result === "success" || e.result === "failure")
  );
}

export interface ReadAuditOptions {
  /** Max entries returned, newest first. Defaults to 200, clamped to 1..1000. */
  limit?: number;
  /**
   * Only entries strictly older than this unix-ms timestamp are returned
   * (the pagination cursor). Entries whose `ts` does not parse are never
   * dropped by the cursor — they are treated as unfilterable and kept.
   */
  beforeTs?: number | null;
  /** Exact action, or a prefix ending in `*` / `.`. */
  action?: string;
  /** Restrict to a result. */
  result?: AuditResult;
}

/** Actions match exactly, or by prefix when the filter ends in `*` or `.`. */
export function auditActionMatches(entryAction: string, filter: string): boolean {
  if (filter.endsWith("*")) {
    return entryAction.startsWith(filter.slice(0, -1));
  }
  if (filter.endsWith(".")) {
    return entryAction.startsWith(filter);
  }
  return entryAction === filter;
}

/** Unix ms for an entry's ISO `ts`; NaN when the stored string does not parse. */
export function auditEntryTsMs(entry: AuditEntry): number {
  return Date.parse(entry.ts);
}

export interface ReadAuditPageOptions {
  /** Max entries returned, newest first. Defaults to 200, clamped to 1..1000. */
  limit?: number;
  /** Exclusive cursor: entries at/after this position are skipped. */
  before?: AuditCursor;
  /** Exact action, or a prefix ending in `*` / `.` (e.g. `provider.`). */
  action?: string;
  result?: AuditResult;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Cursor for the next page, or null when no more matching entries exist. */
  nextCursor: string | null;
}

/**
 * Composite pagination cursor: the last returned entry's timestamp plus
 * how many entries sharing that exact millisecond were already returned
 * (0-based, newest first). The offset is what makes same-millisecond
 * pages exact: a bare-ms cursor cannot tell the second same-ms event
 * apart from the first, so it either drops it or returns it twice.
 */
export interface AuditCursor {
  ms: number;
  offset: number;
}

/** Wire form of a cursor: "<ms>:<offset>". */
export function formatAuditCursor(cursor: AuditCursor): string {
  return `${cursor.ms}:${cursor.offset}`;
}

/**
 * Parse a `before` cursor: "ms:offset", or a bare "ms" (legacy clients —
 * treated as offset 0, i.e. the next page may repeat a same-ms entry
 * rather than dropping one). Returns null when the value is not a
 * positive millisecond timestamp with a non-negative integer offset.
 */
export function parseAuditCursor(raw: string): AuditCursor | null {
  const match = /^(\d+)(?::(\d+))?$/.exec(raw.trim());
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  const offset = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { ms, offset };
}

/** Exact action, or a prefix ending in `*` / `.` (e.g. `provider.`). */
export function matchesAction(entryAction: string, filter: string): boolean {
  if (filter.endsWith("*")) {
    return entryAction.startsWith(filter.slice(0, -1));
  }
  if (filter.endsWith(".")) {
    return entryAction.startsWith(filter);
  }
  return entryAction === filter;
}

/** Unix ms for an entry's ISO `ts`; NaN when the stored string does not parse. */
function entryTsMs(entry: AuditEntry): number {
  return Date.parse(entry.ts);
}

/**
 * One audit page for a caller, newest first, read backwards from EOF in
 * bounded chunks. Predicates are applied as lines stream in, so the read
 * stops as soon as limit+1 matches are collected — it never loads the
 * whole file, and filtering no longer caps out at the 1,000 newest rows.
 * Malformed lines (e.g. a torn trailing line after a crash) are skipped,
 * never fatal. Entries belonging to other users are never returned.
 */
export function readAuditPage(user: string, options: ReadAuditPageOptions = {}): AuditPage {
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_AUDIT_LIMIT) || DEFAULT_AUDIT_LIMIT, 1),
    MAX_AUDIT_LIMIT,
  );
  const before = options.before;
  const actionFilter = options.action ?? "";
  const resultFilter = options.result;

  let fd: number;
  try {
    fd = fs.openSync(getAuditFile(), "r");
  } catch {
    return { entries: [], nextCursor: null };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { entries: [], nextCursor: null };
    const matches: AuditEntry[] = [];
    // Entries with the cursor's exact ms seen so far (newest first) that
    // passed the other predicates — the cursor offset counts these.
    let sameMsSeen = 0;
    const consider = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // Skip a torn or hand-edited line; later appends stay valid.
      }
      if (!isAuditEntry(parsed) || parsed.user !== user) return;
      if (actionFilter && !matchesAction(parsed.action, actionFilter)) return;
      if (resultFilter && parsed.result !== resultFilter) return;
      if (before) {
        const ms = entryTsMs(parsed);
        if (!Number.isNaN(ms)) {
          if (ms > before.ms) return;
          if (ms === before.ms) {
            // Skip the entries already returned for this millisecond.
            if (sameMsSeen <= before.offset) {
              sameMsSeen++;
              return;
            }
            sameMsSeen++;
          }
        }
        // Unparseable ts: kept, never dropped by the cursor.
      }
      matches.push(parsed);
    };

    let pos = size;
    let tail = Buffer.alloc(0);
    const chunk = Buffer.alloc(AUDIT_READ_CHUNK_BYTES);
    while (pos > 0 && matches.length <= limit) {
      const len = Math.min(AUDIT_READ_CHUNK_BYTES, pos);
      pos -= len;
      const read = fs.readSync(fd, chunk, 0, len, pos);
      // Newline (0x0A) never appears inside a multi-byte UTF-8 character,
      // so byte-splitting on it is exact; complete lines decode intact.
      const combined = Buffer.concat([chunk.subarray(0, read), tail]);
      const firstNl = combined.indexOf(0x0a);
      if (firstNl === -1) {
        // No complete line in this window (a line longer than the chunk):
        // carry everything to the next iteration.
        tail = Buffer.from(combined);
        if (pos === 0) {
          consider(tail.toString("utf8"));
          tail = Buffer.alloc(0);
        }
        continue;
      }
      // The head fragment is a partial line unless this chunk starts the file.
      tail = Buffer.from(combined.subarray(0, firstNl));
      const rest = combined.subarray(firstNl + 1).toString("utf8");
      const lines = rest.split("\n");
      for (let i = lines.length - 1; i >= 0 && matches.length <= limit; i--) {
        consider(lines[i]);
      }
      if (pos === 0 && tail.length > 0) {
        // The file's first line has no leading newline to split on.
        consider(tail.toString("utf8"));
        tail = Buffer.alloc(0);
      }
    }

    if (matches.length > limit) {
      const entries = matches.slice(0, limit);
      const last = entries[entries.length - 1];
      const lastMs = entryTsMs(last);
      let nextCursor: string | null = null;
      if (!Number.isNaN(lastMs)) {
        // The offset is the last entry's GLOBAL index within its
        // millisecond group, not just its index on this page: when the
        // group spans pages, the incoming cursor already accounts for the
        // same-ms entries returned earlier.
        let sameMs = 0;
        for (const e of entries) {
          if (entryTsMs(e) === lastMs) sameMs++;
        }
        const offset = before && before.ms === lastMs ? before.offset + sameMs : sameMs - 1;
        nextCursor = formatAuditCursor({ ms: lastMs, offset });
      }
      return { entries, nextCursor };
    }
    return { entries: matches, nextCursor: null };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Audit entries for one caller, newest first, optionally filtered. Malformed
 * lines (e.g. a torn trailing line after a crash) are skipped, never fatal.
 * Entries belonging to other users are never returned.
 *
 * Filtering happens here — across the entire caller's log, not after
 * truncating to a fixed window — so an entry older than any fixed cap remains
 * reachable through cursor pagination. Same-timestamp entries keep their
 * reverse-insertion order (later line first).
 */
export function readAuditEntries(user: string, options: ReadAuditOptions = {}): AuditEntry[] {
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? DEFAULT_AUDIT_LIMIT) || DEFAULT_AUDIT_LIMIT, 1),
    MAX_AUDIT_LIMIT,
  );
  const beforeTs = options.beforeTs ?? null;
  const actionFilter = options.action;
  const resultFilter = options.result;

  let text: string;
  try {
    text = fs.readFileSync(getAuditFile(), "utf8");
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isAuditEntry(parsed) && parsed.user === user) entries.push(parsed);
    } catch {
      // Skip a torn or hand-edited line; later appends stay valid.
    }
  }

  // Newest first; equal timestamps keep reverse-insertion order.
  entries.reverse();

  const out: AuditEntry[] = [];
  for (const entry of entries) {
    if (beforeTs !== null) {
      const ms = auditEntryTsMs(entry);
      if (!Number.isNaN(ms) && ms >= beforeTs) continue;
    }
    if (actionFilter && !auditActionMatches(entry.action, actionFilter)) continue;
    if (resultFilter && entry.result !== resultFilter) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
