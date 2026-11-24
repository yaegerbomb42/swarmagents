// Suite shape + grading tri-state: for every task, grading must FAIL on
// the starting code, PASS on the solution, and FAIL on the broken variant.
// A task that does not satisfy all three is not a benchmark — it is a
// tautology (always passes) or an impossible task (never passes).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVAL_SUITE } from "./suite";
import { gradeRunDir } from "./driver";

async function materialize(
  dir: string,
  files: Record<string, string>,
  testFile: { path: string; content: string }
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const testTarget = path.join(dir, testFile.path);
  await mkdir(path.dirname(testTarget), { recursive: true });
  await writeFile(testTarget, testFile.content, "utf8");
}

test("suite has 15 tasks, 5 per bucket", () => {
  assert.equal(EVAL_SUITE.length, 15);
  for (const bucket of ["surgical", "feature", "long-horizon"] as const) {
    assert.equal(
      EVAL_SUITE.filter((t) => t.bucket === bucket).length,
      5,
      `bucket ${bucket} must have 5 tasks`
    );
  }
  const ids = new Set(EVAL_SUITE.map((t) => t.id));
  assert.equal(ids.size, 15, "task ids must be unique");
  for (const task of EVAL_SUITE) {
    assert.ok(task.repoCommit.length > 0, `${task.id} needs a pinned repoCommit`);
    assert.ok(Object.keys(task.files).length > 0, `${task.id} needs starting files`);
    assert.ok(Object.keys(task.solution).length > 0, `${task.id} needs a solution`);
    assert.ok(Object.keys(task.broken).length > 0, `${task.id} needs a broken variant`);
    if (task.bucket === "surgical") assert.ok(task.targetTurns <= 15);
    if (task.bucket === "feature") assert.ok(task.targetTurns <= 80);
  }
});

for (const task of EVAL_SUITE) {
  test(`grading tri-state: ${task.id}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "eval-suite-test-"));
    try {
      // Starting code fails.
      await materialize(dir, task.files, task.test);
      const start = await gradeRunDir(dir, task.test.path);
      assert.ok(start.total > 0, "grading must run at least one assertion");
      assert.ok(start.failed > 0, "starting code must fail grading");

      // Solution passes.
      await materialize(dir, task.solution, task.test);
      const solved = await gradeRunDir(dir, task.test.path);
      assert.equal(solved.failed, 0, `solution must pass all grading tests: ${JSON.stringify(solved)}`);
      assert.ok(solved.passed > 0);

      // Broken variant fails.
      await materialize(dir, task.broken, task.test);
      const broken = await gradeRunDir(dir, task.test.path);
      assert.ok(broken.failed > 0, "broken variant must fail grading");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
