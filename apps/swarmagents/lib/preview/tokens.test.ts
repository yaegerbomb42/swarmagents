import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configurePreviewShareDir,
  createPreviewShare,
  listPreviewShares,
  resolvePreviewShare,
  revokePreviewShare,
} from "./tokens";

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-preview-tokens-"));
  t.after(() => {
    configurePreviewShareDir("");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  configurePreviewShareDir(dir);
  return dir;
}

test("preview tokens: create, resolve, list, revoke, rotate", (t) => {
  tempDir(t);
  const share = createPreviewShare("alice", 3000);
  assert.match(share.token, /^[a-f0-9]{48}$/);
  assert.equal(share.port, 3000);

  const resolved = resolvePreviewShare(share.token);
  assert.deepEqual(resolved, { ownerId: "alice", port: 3000, createdAt: share.createdAt });

  assert.equal(listPreviewShares("alice").length, 1);
  assert.equal(listPreviewShares("bob").length, 0);

  // Rotating the token for the same port kills the old link.
  const rotated = createPreviewShare("alice", 3000);
  assert.notEqual(rotated.token, share.token);
  assert.equal(resolvePreviewShare(share.token), null);
  assert.equal(resolvePreviewShare(rotated.token)?.ownerId, "alice");
  assert.equal(listPreviewShares("alice").length, 1);

  // A second port gets its own token; revoking one leaves the other live.
  const other = createPreviewShare("alice", 5173);
  assert.equal(listPreviewShares("alice").length, 2);
  assert.equal(revokePreviewShare("alice", 3000), true);
  assert.equal(resolvePreviewShare(rotated.token), null);
  assert.equal(resolvePreviewShare(other.token)?.port, 5173);
  assert.equal(revokePreviewShare("alice", 3000), false);
  assert.equal(revokePreviewShare("alice", 9999), false);
});

test("preview tokens: a token never resolves for another user's VM", (t) => {
  tempDir(t);
  const share = createPreviewShare("alice", 3000);
  assert.equal(resolvePreviewShare(share.token)?.ownerId, "alice");
  // No API in this module takes an owner alongside a token: the index entry
  // is the single source of truth, so there is no way to rebind it.
  assert.equal(listPreviewShares("bob").length, 0);
});

test("preview tokens: malformed tokens and missing files never resolve", (t) => {
  tempDir(t);
  assert.equal(resolvePreviewShare(""), null);
  assert.equal(resolvePreviewShare("not-a-token"), null);
  assert.equal(resolvePreviewShare("a".repeat(48)), null);
  assert.equal(resolvePreviewShare("A".repeat(48)), null);
  assert.deepEqual(listPreviewShares("nobody"), []);
  assert.equal(revokePreviewShare("nobody", 3000), false);
});

test("preview tokens: a stale index entry is dropped when the share is gone", (t) => {
  const dir = tempDir(t);
  const share = createPreviewShare("alice", 3000);
  // Simulate a crashed revoke: the owner's file loses the share but the
  // index entry survives.
  const userFile = path.join(dir, "users");
  const hash = fs.readdirSync(userFile)[0];
  fs.writeFileSync(
    path.join(userFile, hash, "preview-tokens.json"),
    JSON.stringify({ version: 1, userId: "alice", shares: [] }),
  );
  assert.equal(resolvePreviewShare(share.token), null);
  assert.equal(fs.existsSync(path.join(dir, "preview-shares", `${share.token}.json`)), false);
});
