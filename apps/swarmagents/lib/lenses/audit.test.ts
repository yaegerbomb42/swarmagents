import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditFilePath,
  classifyLensFindings,
  pinnedLensForRole,
  readRunAudit,
  runAutoAudit,
} from "./audit.js";
import { writeUserCustomRoles } from "../roles-store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-audit-"));
}

test("classifyLensFindings marks severity-tagged findings as warn", () => {
  assert.equal(classifyLensFindings("No issues found"), "pass");
  assert.equal(classifyLensFindings("Everything looks clean."), "pass");
  assert.equal(classifyLensFindings("- [low] cosmetic — nit — ignore"), "warn");
  assert.equal(classifyLensFindings("- [critical] secret in code — leak — rotate"), "warn");
  assert.equal(classifyLensFindings("fine before\n- [high] authz broken — impact — fix"), "warn");
});

test("pinnedLensForRole resolves a role's pinned lens from the catalog", () => {
  const dir = tmpDir();
  const oldHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = dir;
  try {
    // No roleId → no lens.
    assert.equal(pinnedLensForRole("alice", undefined), undefined);
    assert.equal(pinnedLensForRole("alice", ""), undefined);
    // Unknown role → no lens.
    assert.equal(pinnedLensForRole("alice", "does-not-exist"), undefined);
    // Built-in Implementer (Coder) ships with the security lens.
    assert.equal(pinnedLensForRole("alice", "implementer"), "security");
    // A role without a pin has none.
    assert.equal(pinnedLensForRole("alice", "main"), undefined);
    // A custom role can pin its own lens.
    writeUserCustomRoles("alice", [
      {
        id: "code-scribe",
        name: "Code Scribe",
        description: "Writes code",
        glyph: "✍",
        model: "",
        permissions: { readOnly: false, allowBash: true, allowWrite: true, allowNetwork: false, allowBrowser: false, allowSubagents: false },
        tools: ["read_file", "write_file"],
        mcpServers: [],
        skills: [],
        instructions: "",
        category: "build",
        builtin: false,
        lens: "code-review",
      },
    ]);
    assert.equal(pinnedLensForRole("alice", "code-scribe"), "code-review");
  } finally {
    if (oldHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAutoAudit returns an existing audit without re-running", async () => {
  const dir = tmpDir();
  const runId = "run_audit_existing";
  try {
    fs.mkdirSync(path.dirname(auditFilePath(dir, runId)), { recursive: true });
    fs.writeFileSync(
      auditFilePath(dir, runId),
      JSON.stringify({ lens: "security", verdict: "warn", cached: false, text: "- [high] x", createdAt: 1 }),
      "utf8",
    );
    const audit = await runAutoAudit({ userId: "alice", runId, lens: "security", runsDir: dir });
    assert.ok(audit);
    assert.equal(audit.verdict, "warn");
    assert.equal(audit.createdAt, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAutoAudit no-ops when no report exists yet", async () => {
  const dir = tmpDir();
  try {
    const audit = await runAutoAudit({ userId: "alice", runId: "run_no_report", lens: "security", runsDir: dir });
    assert.equal(audit, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunAudit returns null when no audit exists", () => {
  const dir = tmpDir();
  try {
    assert.equal(readRunAudit("run_missing", dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
