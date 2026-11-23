/**
 * Tests for the t97 remote branch check: `git ls-remote` parsing, the
 * env kill-switch, and repo-root discovery — all with a stubbed git so
 * no test needs a real remote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBranchOnRemote, findRepoRoot, isGitRemoteCheckEnabled } from "./git-remote";

test("isGitRemoteCheckEnabled is on by default, off only with SWARM_GIT_REMOTE_CHECK=0", () => {
  assert.equal(isGitRemoteCheckEnabled({}), true);
  assert.equal(isGitRemoteCheckEnabled({ SWARM_GIT_REMOTE_CHECK: "1" }), true);
  assert.equal(isGitRemoteCheckEnabled({ SWARM_GIT_REMOTE_CHECK: "banana" }), true);
  assert.equal(isGitRemoteCheckEnabled({ SWARM_GIT_REMOTE_CHECK: "0" }), false);
});

test("findRepoRoot walks up to a .git dir and returns null outside a repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-git-remote-"));
  try {
    fs.mkdirSync(path.join(dir, ".git"));
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findRepoRoot(nested), dir);
    assert.equal(findRepoRoot(path.join(dir, ".git")), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(findRepoRoot(os.tmpdir()), null);
});

test("checkBranchOnRemote reports exists when ls-remote returns the ref", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-git-remote-"));
  try {
    fs.mkdirSync(path.join(dir, ".git"));
    let seenArgs: string[] = [];
    const exec = async (cmd: string, args: string[]): Promise<{ stdout: string }> => {
      seenArgs = args;
      assert.equal(cmd, "git");
      return { stdout: "abc123def456\trefs/heads/feat/x\n" };
    };
    const checked = await checkBranchOnRemote("feat/x", { cwd: dir, exec });
    assert.deepEqual(checked, { ok: true, exists: true });
    assert.ok(seenArgs.includes("ls-remote"));
    assert.ok(seenArgs.includes("origin"));
    assert.ok(seenArgs.includes("refs/heads/feat/x"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkBranchOnRemote reports missing when ls-remote returns nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-git-remote-"));
  try {
    fs.mkdirSync(path.join(dir, ".git"));
    const exec = async (): Promise<{ stdout: string }> => ({ stdout: "" });
    assert.deepEqual(await checkBranchOnRemote("feat/never-pushed", { cwd: dir, exec }), {
      ok: true,
      exists: false,
    });
    // Whitespace-only output is also "no ref".
    const blank = async (): Promise<{ stdout: string }> => ({ stdout: "  \n" });
    assert.deepEqual(await checkBranchOnRemote("feat/never-pushed", { cwd: dir, exec: blank }), {
      ok: true,
      exists: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkBranchOnRemote requires an exact ref match (ls-remote fnmatch must not false-positive)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-git-remote-"));
  try {
    fs.mkdirSync(path.join(dir, ".git"));
    // A glob query like refs/heads/feat/* matches other feat branches;
    // only an exact refs/heads/<branch> line counts as "exists".
    const globExec = async (): Promise<{ stdout: string }> => ({
      stdout: "abc123\trefs/heads/feat/other\ndef456\trefs/heads/feat/another\n",
    });
    assert.deepEqual(await checkBranchOnRemote("feat/*", { cwd: dir, exec: globExec }), {
      ok: true,
      exists: false,
    });
    // A prefix match is not enough either: refs/heads/feat/x must not
    // match refs/heads/feat/xy.
    const prefixExec = async (): Promise<{ stdout: string }> => ({
      stdout: "abc123\trefs/heads/feat/xy\n",
    });
    assert.deepEqual(await checkBranchOnRemote("feat/x", { cwd: dir, exec: prefixExec }), {
      ok: true,
      exists: false,
    });
    // Exact match among other refs still counts.
    const mixedExec = async (): Promise<{ stdout: string }> => ({
      stdout: "abc123\trefs/heads/feat/other\ndef456\trefs/heads/feat/x\n",
    });
    assert.deepEqual(await checkBranchOnRemote("feat/x", { cwd: dir, exec: mixedExec }), {
      ok: true,
      exists: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkBranchOnRemote reports ok:false when git fails or no repo exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-git-remote-"));
  try {
    fs.mkdirSync(path.join(dir, ".git"));
    const failing = async (): Promise<{ stdout: string }> => {
      throw new Error("fatal: unable to connect to github.com");
    };
    const checked = await checkBranchOnRemote("feat/x", { cwd: dir, exec: failing });
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.reason, /git ls-remote failed/);
    // No .git above the cwd: the check cannot run at all.
    const noRepo = await checkBranchOnRemote("feat/x", { cwd: os.tmpdir() });
    assert.equal(noRepo.ok, false);
    if (!noRepo.ok) assert.match(noRepo.reason, /no git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
