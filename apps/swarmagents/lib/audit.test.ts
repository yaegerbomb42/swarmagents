/**
 * Tests for the audit log (lib/audit): JSON-lines append format under a temp
 * SWARM_HOME, caller-scoped reads, and the "never secrets" shape guarantee.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_FILE_NAME,
  configureAuditPath,
  getAuditFile,
  readAuditEntries,
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
