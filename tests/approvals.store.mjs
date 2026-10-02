#!/usr/bin/env node
// Store-level tests for the approval grants/denials. The classifier tests (approvals.mjs) cover *what*
// parks a run; these cover the grant lifecycle: a grant is single-use, bound to one action, expiring,
// and a denial is durable for the task. A stale grant silently authorising an action deep into an
// unattended run is the failure this file guards against.
//
//   npm run test:approvals:store

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-approvals-home-"));
process.env.SWARM_HOME = HOME;

const { grantApproval, takeApproval, clearApprovals, recordDenial, isDenied, clearDenials, APPROVAL_TTL_MS } = await import("../lib/runtime/store.ts");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

console.log(`approval store (SWARM_HOME=${HOME})`);

// A fresh grant is consumable exactly once, then gone.
await grantApproval({ taskId: "t1", hash: "h1", tool: "bash", label: "rm -rf build", grantedAt: Date.now() });
check("grant is consumable", takeApproval("t1", "h1")?.tool === "bash");
check("grant is single-use", takeApproval("t1", "h1") === null);

// A grant only authorises its own action, never a different one for the same task.
await grantApproval({ taskId: "t1", hash: "h2", tool: "bash", label: "rm -rf src", grantedAt: Date.now() });
check("grant is bound to its hash", takeApproval("t1", "h3") === null);
check("grant still consumable for its own hash", takeApproval("t1", "h2") !== null);

// A stale grant is dropped (not honoured) so the caller re-parks rather than running an old approval.
await grantApproval({ taskId: "t1", hash: "h4", tool: "bash", label: "old", grantedAt: Date.now() - APPROVAL_TTL_MS - 1 });
check("expired grant is refused", takeApproval("t1", "h4") === null);

// A denial is durable for the task and independent of grants.
await recordDenial({ taskId: "t2", hash: "d1", tool: "bash", label: "git push", deniedAt: Date.now() });
check("denial is remembered", isDenied("t2", "d1") === true);
check("denial does not leak across hashes", isDenied("t2", "d2") === false);
check("denial does not leak across tasks", isDenied("t3", "d1") === false);

// Clearing a task's approvals does not touch another task's.
await grantApproval({ taskId: "t4", hash: "k1", tool: "bash", label: "a", grantedAt: Date.now() });
await grantApproval({ taskId: "t5", hash: "k2", tool: "bash", label: "b", grantedAt: Date.now() });
clearApprovals("t4");
check("clearApprovals drops the named task's grant", takeApproval("t4", "k1") === null);
check("clearApprovals leaves other tasks alone", takeApproval("t5", "k2") !== null);

clearDenials("t2");
check("clearDenials forgets the task's refusal", isDenied("t2", "d1") === false);

fs.rmSync(HOME, { recursive: true, force: true });

if (failures) {
  console.log(`\nAPPROVAL STORE FAIL (${failures})`);
  process.exit(1);
}
console.log("\nAPPROVAL STORE PASS");