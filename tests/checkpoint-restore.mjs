// restore-path mirror test: reproduces lib/tools/files.ts restoreCheckpoint + the route's session scan
// against a real on-disk checkpoint layout. Run: node tests/checkpoint-restore.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-ckpt-"));
const SID = "bd5ae3331fd62859";
const dir = path.join(HOME, "checkpoints", SID);
fs.mkdirSync(dir, { recursive: true });

// --- mirror of lib/tools/files.ts ---
const checkpointsDir = (sessionId) => {
  const d = path.join(HOME, "checkpoints", sessionId);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
function restoreCheckpoint(sessionId, checkpointId) {
  if (!/^[a-f0-9]+$/.test(checkpointId)) return { ok: false, message: "Bad checkpoint id." };
  const d = checkpointsDir(sessionId);
  const bak = path.resolve(d, `${checkpointId}.bak`);
  if (!bak.startsWith(d + path.sep)) return { ok: false, message: "Bad checkpoint id." };
  const meta = `${bak}.json`;
  if (!fs.existsSync(bak) || !fs.existsSync(meta)) return { ok: false, message: `Checkpoint ${checkpointId} not found for this task.` };
  try {
    const { path: absPath } = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (typeof absPath !== "string" || !path.isAbsolute(absPath)) return { ok: false, message: "Checkpoint record is invalid; refusing to restore." };
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(bak, absPath);
    return { ok: true, message: `Restored ${absPath} from checkpoint ${checkpointId}.` };
  } catch (e) {
    return { ok: false, message: `Restore failed: ${e.message}` };
  }
}
// --- mirror of the route's session scan ---
function routeRestore(checkpoint) {
  if (!checkpoint || !/^[a-f0-9]+$/.test(checkpoint)) return { status: 400 };
  let sessions = [];
  try {
    sessions = fs.readdirSync(path.join(HOME, "checkpoints"));
  } catch {
    return { status: 404 };
  }
  for (const s of sessions) {
    const r = restoreCheckpoint(s, checkpoint);
    if (r.ok) return { status: 200, message: r.message };
  }
  return { status: 404 };
}

const CID = "abcdef123456";
const target = path.join(HOME, "target.txt");
fs.writeFileSync(path.join(dir, `${CID}.bak`), "ORIGINAL CONTENT\n");
fs.writeFileSync(path.join(dir, `${CID}.bak.json`), JSON.stringify({ path: target, at: Date.now() }));

// 1. Edited file is rolled back to the snapshot.
fs.writeFileSync(target, "MODIFIED AFTER EDIT\n");
let r = routeRestore(CID);
assert.equal(r.status, 200, `restore should succeed, got ${r.status}`);
assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL CONTENT\n");
// 2. Deleted file is recreated.
fs.rmSync(target);
r = routeRestore(CID);
assert.equal(r.status, 200, "restore of a deleted file should succeed");
assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL CONTENT\n");
// 3. Traversal / non-hex ids rejected with 400.
assert.equal(routeRestore("../evil").status, 400);
assert.equal(routeRestore("ABCDEF").status, 400);
assert.equal(routeRestore("").status, 400);
// 4. Unknown but valid-hex id → 404 (no crash).
assert.equal(routeRestore("ffffffffffff").status, 404);
// 5. Corrupt record (relative path) is refused, target untouched.
const CID2 = "beef654321";
const t2 = path.join(HOME, "target2.txt");
fs.writeFileSync(t2, "KEEP ME");
fs.writeFileSync(path.join(dir, `${CID2}.bak`), "bad");
fs.writeFileSync(path.join(dir, `${CID2}.bak.json`), JSON.stringify({ path: "relative/nope.txt", at: Date.now() }));
assert.equal(routeRestore(CID2).status, 404, "bad record must not restore");
assert.equal(fs.readFileSync(t2, "utf8"), "KEEP ME");
// 6. Snapshot without a sidecar is not restorable.
const CID3 = "c0ffee123456";
fs.writeFileSync(path.join(dir, `${CID3}.bak`), "orphan");
assert.equal(routeRestore(CID3).status, 404, "sidecar-less snapshot must not restore");
console.log("checkpoint-restore: 6/6 pass");