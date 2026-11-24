/**
 * Tests for the audit log (lib/audit): JSON-lines append format under a temp
 * SWARM_HOME, caller-scoped reads, and the "never secrets" shape guarantee.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_FILE_NAME,
  configureAuditPath,
  formatAuditCursor,
  getAuditFile,
  parseAuditCursor,
  readAuditEntries,
  readAuditPage,
  recordAudit,
} from "./audit";

let dir: string;
let prevHome: string | undefined;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-audit-"));
  prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = dir;
  configureAuditPath(undefined);
});

test.afterEach(() => {
  configureAuditPath(undefined);
  if (prevHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

test("getAuditFile stores audit.jsonl directly under SWARM_HOME", () => {
  assert.equal(getAuditFile(), join(dir, AUDIT_FILE_NAME));
});

test("recordAudit appends one JSON line with exactly ts/user/action/target/result", () => {
  recordAudit({ user: "alice", action: "provider.key.add", target: "openai", result: "success" });
  const lines = readFileSync(join(dir, AUDIT_FILE_NAME), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  // Exactly the five fields — nothing else (in particular no key material)
  // can ever be written by this module.
  assert.deepEqual(Object.keys(entry).sort(), ["action", "result", "target", "ts", "user"]);
  assert.equal(entry.user, "alice");
  assert.equal(entry.action, "provider.key.add");
  assert.equal(entry.target, "openai");
  assert.equal(entry.result, "success");
  assert.ok(!Number.isNaN(Date.parse(entry.ts as string)), "ts must be an ISO timestamp");
});

test("recordAudit appends successive entries and never writes secret material", () => {
  recordAudit({ user: "alice", action: "provider.key.rotate", target: "openai", result: "success" });
  recordAudit({ user: "alice", action: "login.failure", target: "alice@example.com", result: "failure" });
  const text = readFileSync(join(dir, AUDIT_FILE_NAME), "utf8");
  assert.equal(text.trim().split("\n").length, 2);
  assert.ok(!text.includes("sk-"), "no key material may appear in the log");
  assert.ok(!text.includes("correct horse"), "no password material may appear in the log");
});

test("readAuditEntries returns only the caller's entries, newest first", () => {
  recordAudit({ user: "alice", action: "snapshot.create", target: "before-upgrade", result: "success" });
  recordAudit({ user: "bob", action: "snapshot.create", target: "bob-snap", result: "success" });
  recordAudit({ user: "alice", action: "snapshot.restore", target: "before-upgrade", result: "success" });

  const alice = readAuditEntries("alice");
  assert.equal(alice.length, 2);
  assert.equal(alice[0].action, "snapshot.restore");
  assert.equal(alice[1].action, "snapshot.create");
  assert.ok(alice.every((e) => e.user === "alice"));

  const bob = readAuditEntries("bob");
  assert.equal(bob.length, 1);
  assert.equal(bob[0].target, "bob-snap");

  assert.deepEqual(readAuditEntries("carol"), []);
});

test("readAuditEntries honors limit and skips malformed lines", () => {
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });
  writeFileSync(join(dir, AUDIT_FILE_NAME), "{not json\n", { flag: "a" });
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });

  const all = readAuditEntries("alice");
  assert.equal(all.length, 3);
  assert.equal(readAuditEntries("alice", { limit: 2 }).length, 2);
});

test("readAuditEntries returns [] when no audit file exists", () => {
  assert.deepEqual(readAuditEntries("alice"), []);
});

test("recordAudit never throws when the audit file cannot be written", () => {
  // SWARM_HOME pointing at a regular file: mkdir/append both fail.
  const fileAsHome = join(dir, "not-a-dir");
  writeFileSync(fileAsHome, "x");
  process.env.SWARM_HOME = fileAsHome;
  assert.doesNotThrow(() =>
    recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" }),
  );
});

/** Page through every entry with composite cursors; returns targets newest-first. */
function pageAll(user: string, limit: number, options: { action?: string } = {}): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = readAuditPage(user, {
      limit,
      action: options.action,
      before: cursor ? parseAuditCursor(cursor) ?? undefined : undefined,
    });
    seen.push(...page.entries.map((e) => e.target));
    cursor = page.nextCursor ?? undefined;
    pages++;
    assert.ok(pages < 20, "must finish in a handful of pages");
  } while (cursor);
  return seen;
}

test("readAuditPage paginates past 1,000 entries with composite cursors, no drops or repeats", () => {
  const base = Date.UTC(2026, 0, 1);
  const lines: string[] = [];
  for (let i = 0; i < 1200; i++) {
    lines.push(
      JSON.stringify({
        ts: new Date(base + i).toISOString(),
        user: "alice",
        action: "login.success",
        target: `t-${i}`,
        result: "success",
      }),
    );
  }
  writeFileSync(join(dir, AUDIT_FILE_NAME), `${lines.join("\n")}\n`, "utf8");

  const seen = pageAll("alice", 200);
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200, "no entry may repeat across pages");
  assert.equal(seen[0], "t-1199");
  assert.equal(seen[1199], "t-0");
});

test("readAuditPage applies filters in the read path, reaching matches past 1,000 rows", () => {
  // Only the 5 OLDEST entries match the filter — the old read capped to
  // the 1,000 newest rows before filtering, so it returned none of them.
  const base = Date.UTC(2026, 0, 1);
  const lines: string[] = [];
  for (let i = 0; i < 1200; i++) {
    lines.push(
      JSON.stringify({
        ts: new Date(base + i).toISOString(),
        user: "alice",
        action: i < 5 ? "login.failure" : "login.success",
        target: `t-${i}`,
        result: "success",
      }),
    );
  }
  writeFileSync(join(dir, AUDIT_FILE_NAME), `${lines.join("\n")}\n`, "utf8");

  const page = readAuditPage("alice", { action: "login.failure" });
  assert.deepEqual(
    page.entries.map((e) => e.target),
    ["t-4", "t-3", "t-2", "t-1", "t-0"],
  );
  assert.equal(page.nextCursor, null);
});

test("readAuditPage pages exactly across a same-millisecond boundary", () => {
  const ms = Date.UTC(2026, 0, 1);
  const mk = (target: string, ts: number) =>
    JSON.stringify({
      ts: new Date(ts).toISOString(),
      user: "alice",
      action: "login.success",
      target,
      result: "success",
    });
  const lines = [
    mk("before", ms - 1),
    mk("same-0", ms),
    mk("same-1", ms),
    mk("same-2", ms),
    mk("same-3", ms),
    mk("same-4", ms),
    mk("after", ms + 1),
  ];
  writeFileSync(join(dir, AUDIT_FILE_NAME), `${lines.join("\n")}\n`, "utf8");

  const seen = pageAll("alice", 2);
  assert.deepEqual(seen, ["after", "same-4", "same-3", "same-2", "same-1", "same-0", "before"]);
});

test("readAuditPage reads backwards in bounded chunks across boundaries and long lines", () => {
  const base = Date.UTC(2026, 0, 1);
  const mk = (target: string, ts: number, user = "alice") =>
    JSON.stringify({ ts: new Date(ts).toISOString(), user, action: "login.success", target, result: "success" });
  // A single line far longer than the 64 KiB read chunk, plus entries on
  // both sides of it, plus other users' noise to force a long scan back.
  // No trailing newline, and a torn trailing fragment that must be skipped.
  const longTarget = "x".repeat(100_000);
  const lines = [
    mk("oldest", base),
    mk("bob-1", base + 1, "bob"),
    JSON.stringify({ ts: new Date(base + 2).toISOString(), user: "alice", action: "login.success", target: longTarget, result: "success" }),
    mk("bob-2", base + 3, "bob"),
    mk("newest", base + 4),
    "{torn json",
  ];
  writeFileSync(join(dir, AUDIT_FILE_NAME), lines.join("\n"), "utf8");

  const page = readAuditPage("alice", { limit: 10 });
  assert.equal(page.entries.length, 3);
  assert.equal(page.entries[0].target, "newest");
  assert.equal(page.entries[1].target, longTarget);
  assert.equal(page.entries[2].target, "oldest");
  assert.equal(page.nextCursor, null);
});

test("parseAuditCursor accepts ms:offset and bare ms, rejects the rest", () => {
  assert.deepEqual(parseAuditCursor("123:2"), { ms: 123, offset: 2 });
  assert.deepEqual(parseAuditCursor("123"), { ms: 123, offset: 0 });
  assert.deepEqual(parseAuditCursor("  123:0  "), { ms: 123, offset: 0 });
  assert.equal(parseAuditCursor(""), null);
  assert.equal(parseAuditCursor("abc"), null);
  assert.equal(parseAuditCursor("123:"), null);
  assert.equal(parseAuditCursor("123:2:3"), null);
  assert.equal(parseAuditCursor("123:-1"), null);
  assert.equal(parseAuditCursor("0"), null);
  assert.equal(parseAuditCursor("-5"), null);
  assert.equal(parseAuditCursor("1.5"), null);
  assert.equal(formatAuditCursor({ ms: 123, offset: 2 }), "123:2");
});

test("readAuditPage keeps entries whose ts does not parse and reaches them via paging", () => {
  const lines = [
    JSON.stringify({ ts: "not-a-date", user: "alice", action: "login.success", target: "weird", result: "success" }),
    JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), user: "alice", action: "login.success", target: "normal", result: "success" }),
  ];
  writeFileSync(join(dir, AUDIT_FILE_NAME), `${lines.join("\n")}\n`, "utf8");
  const page1 = readAuditPage("alice", { limit: 1 });
  assert.deepEqual(
    page1.entries.map((e) => e.target),
    ["normal"],
  );
  assert.equal(page1.nextCursor, `${Date.UTC(2026, 0, 1)}:0`);
  assert.ok(page1.nextCursor);
  const page2 = readAuditPage("alice", { limit: 1, before: parseAuditCursor(page1.nextCursor) ?? undefined });
  assert.deepEqual(
    page2.entries.map((e) => e.target),
    ["weird"],
    "an unparseable ts is kept, never dropped by the cursor",
  );
  assert.equal(page2.nextCursor, null);
  const all = readAuditPage("alice", { limit: 10 });
  assert.deepEqual(
    all.entries.map((e) => e.target),
    ["normal", "weird"],
  );

  // When the last RETURNED entry itself has no parseable ts, no cursor is
  // produced (the pre-existing documented behavior).
  const lines2 = [
    JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), user: "alice", action: "login.success", target: "normal", result: "success" }),
    JSON.stringify({ ts: "not-a-date", user: "alice", action: "login.success", target: "weird", result: "success" }),
  ];
  writeFileSync(join(dir, AUDIT_FILE_NAME), `${lines2.join("\n")}\n`, "utf8");
  const first = readAuditPage("alice", { limit: 1 });
  assert.deepEqual(
    first.entries.map((e) => e.target),
    ["weird"],
  );
  assert.equal(first.nextCursor, null);
});

test("recordAudit creates audit.jsonl with mode 0o600 and tightens an existing file", () => {
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });
  const file = join(dir, AUDIT_FILE_NAME);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // A file created before this fix (0o644) is tightened on the next write.
  chmodSync(file, 0o644);
  recordAudit({ user: "alice", action: "login.success", target: "alice", result: "success" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});

test("recordAudit rotates the log once it passes the size threshold", () => {
  const prev = process.env.SWARM_AUDIT_ROTATE_BYTES;
  process.env.SWARM_AUDIT_ROTATE_BYTES = "200";
  try {
    recordAudit({ user: "alice", action: "login.success", target: "one", result: "success" });
    recordAudit({ user: "alice", action: "login.success", target: "two", result: "success" });
    recordAudit({ user: "alice", action: "login.success", target: "three", result: "success" });
    const file = join(dir, AUDIT_FILE_NAME);
    const rotated = `${file}.1`;
    // Two ~108-byte entries exceed the 200-byte threshold, so the third
    // write rotated the first two into audit.jsonl.1.
    const rotatedText = readFileSync(rotated, "utf8");
    assert.ok(rotatedText.includes('"target":"one"'));
    assert.ok(rotatedText.includes('"target":"two"'));
    const currentText = readFileSync(file, "utf8");
    assert.ok(currentText.includes('"target":"three"'));
    assert.ok(!currentText.includes('"target":"one"'));
    assert.equal(statSync(rotated).mode & 0o777, 0o600, "the rotated file keeps the 0o600 mode");
    assert.equal(readAuditEntries("alice").length, 1, "reads see only the current file");
  } finally {
    if (prev === undefined) delete process.env.SWARM_AUDIT_ROTATE_BYTES;
    else process.env.SWARM_AUDIT_ROTATE_BYTES = prev;
  }
});

test("recordAudit appends to an existing file without rotating below the threshold", () => {
  recordAudit({ user: "alice", action: "login.success", target: "one", result: "success" });
  recordAudit({ user: "alice", action: "login.success", target: "two", result: "success" });
  assert.equal(readFileSync(join(dir, AUDIT_FILE_NAME), "utf8").trim().split("\n").length, 2);
  assert.throws(() => readFileSync(join(dir, `${AUDIT_FILE_NAME}.1`), "utf8"), /ENOENT/);
});
