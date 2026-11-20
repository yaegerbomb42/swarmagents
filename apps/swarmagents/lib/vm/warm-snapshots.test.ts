import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWarmGoldenSnapshot,
  fingerprintManifests,
  rankManifests,
  selectWarmSnapshot,
  warmLabelFor,
  type WarmVm,
} from "./warm-snapshots";

const pkg = {
  path: "/workspace/app/package.json",
  sha256: "a".repeat(64),
};
const req = {
  path: "/workspace/api/requirements.txt",
  sha256: "b".repeat(64),
};

test("rankManifests prefers higher churn times fan-in and caps the set", () => {
  const ranked = rankManifests([pkg, req], [
    { path: "app/package.json", churn90d: 2, fanIn: 1 },
    { path: "api/requirements.txt", churn90d: 10, fanIn: 4 },
  ]);
  assert.equal(ranked[0]?.path, req.path);
  assert.ok(ranked[0]!.priority > ranked[1]!.priority);
  assert.equal(ranked[0]?.kind, "pip");
  assert.equal(ranked[1]?.kind, "npm");
});

test("rankManifests drops paths outside /workspace", () => {
  const ranked = rankManifests(
    [{ path: "/etc/package.json", sha256: "c".repeat(64) }, pkg],
    [],
  );
  assert.deepEqual(ranked.map((m) => m.path), [pkg.path]);
});

test("selectWarmSnapshot matches the fingerprint label only", () => {
  const files = rankManifests([pkg], []);
  const fp = fingerprintManifests(files);
  const label = warmLabelFor(fp);
  assert.equal(selectWarmSnapshot(["other", label], fp), label);
  assert.equal(selectWarmSnapshot(["warm-ffffffffffff"], fp), null);
});

test("applyWarmGoldenSnapshot boots an existing match and does not reinstall", async () => {
  const files = rankManifests([pkg], [{ path: "app/package.json", churn90d: 3, fanIn: 2 }]);
  const label = warmLabelFor(fingerprintManifests(files));
  const calls: string[] = [];
  const vm: WarmVm = {
    async exec(_user, cmd, opts) {
      calls.push(cmd[0] ?? "");
      if (cmd[0] === "find") opts?.onStdout?.(`${pkg.path}\n`);
      if (cmd[0] === "sha256sum") opts?.onStdout?.(`${pkg.sha256}  ${pkg.path}\n`);
      return { exitCode: 0 };
    },
    async listSnapshots() {
      return [{ label }];
    },
    async snapshot() {
      calls.push("snapshot");
    },
    async bootFromImage(_user, booted) {
      calls.push(`boot:${booted}`);
    },
  };
  const result = await applyWarmGoldenSnapshot(vm, "alice", [
    { path: "app/package.json", churn90d: 3, fanIn: 2 },
  ]);
  assert.equal(result.action, "booted");
  assert.equal(result.label, label);
  assert.ok(calls.includes(`boot:${label}`));
  assert.equal(calls.includes("npm"), false);
  assert.equal(calls.includes("snapshot"), false);
});

test("applyWarmGoldenSnapshot builds and snapshots when nothing matches", async () => {
  const calls: string[][] = [];
  const vm: WarmVm = {
    async exec(_user, cmd, opts) {
      calls.push(cmd);
      if (cmd[0] === "find") opts?.onStdout?.(`${pkg.path}\n`);
      if (cmd[0] === "sha256sum") opts?.onStdout?.(`${pkg.sha256}  ${pkg.path}\n`);
      if (cmd[0] === "sh") opts?.onStdout?.("/home/node");
      return { exitCode: 0 };
    },
    async listSnapshots() {
      return [];
    },
    async snapshot(_user, label) {
      calls.push(["snapshot", label]);
    },
    async bootFromImage() {
      throw new Error("should not boot");
    },
  };
  const result = await applyWarmGoldenSnapshot(vm, "alice", []);
  assert.equal(result.action, "built");
  assert.ok(calls.some((c) => c[0] === "npm" && c[1] === "install"));
  assert.ok(calls.some((c) => c[0] === "snapshot" && c[1] === result.label));
});
