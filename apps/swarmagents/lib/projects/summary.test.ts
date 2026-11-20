import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectContext, estimateProjectContextTokens, PROJECT_CONTEXT_CHAR_BUDGET } from "./summary";
import type { Project } from "./store";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_12345678-1234-1234-1234-123456789012",
    userId: "alice",
    name: "Atlas",
    repo: "yaegerbomb42/swarmagents",
    workspacePath: "/workspace",
    activeBranch: "feat/g5-project-continuity",
    openFiles: ["apps/swarmagents/lib/runtime/manager.ts", "apps/swarmagents/app/page.tsx"],
    commands: [
      { command: "npm test", exitCode: 1, at: 1 },
      { command: "git status", exitCode: 0, at: 2 },
    ],
    lastTest: {
      command: "npm test",
      ok: false,
      exitCode: 1,
      passed: 41,
      failed: 2,
      failing: ["FAIL lib/projects/store.test.ts", "FAIL lib/runtime/manager.test.ts"],
      at: 3,
    },
    pinnedNotes: ["Do not weaken assertions to make the suite green."],
    threads: ["sess_1"],
    createdAt: 1,
    updatedAt: 3,
    share: null,
    ...overrides,
  };
}

test("project context starts with Previously… and carries the resumable state", () => {
  const context = buildProjectContext(project());
  assert.ok(context.startsWith("Previously…"));
  assert.match(context, /Atlas/);
  assert.match(context, /feat\/g5-project-continuity/);
  assert.match(context, /manager\.ts/);
  assert.match(context, /`npm test` → exit 1/);
  assert.match(context, /Last tests: `npm test` → failing \(exit 1, 41 passed, 2 failed\)/);
  assert.match(context, /FAIL lib\/projects\/store\.test\.ts/);
  assert.match(context, /Do not weaken assertions/);
  assert.ok(estimateProjectContextTokens(context) < 800, "summary must stay under 800 tokens");
});

test("project context is capped even when every field is at its limit", () => {
  const huge = project({
    name: "x".repeat(80),
    openFiles: Array.from({ length: 50 }, (_, index) => `${"dir/".repeat(30)}file-${index}-${"y".repeat(200)}.ts`),
    commands: Array.from({ length: 20 }, (_, index) => ({
      command: `echo ${index} ${"z".repeat(400)}`,
      exitCode: index % 2,
      at: index,
    })),
    lastTest: {
      command: "npm test",
      ok: false,
      exitCode: 1,
      failing: ["FAIL ".concat("q".repeat(280)), "FAIL ".concat("r".repeat(280)), "FAIL ".concat("s".repeat(280))],
      at: 1,
    },
    pinnedNotes: Array.from({ length: 20 }, () => "n".repeat(480)),
  });
  const context = buildProjectContext(huge);
  assert.ok(context.length <= PROJECT_CONTEXT_CHAR_BUDGET);
  assert.ok(estimateProjectContextTokens(context) < 800);
});

test("empty project still yields a short, useful context block", () => {
  const context = buildProjectContext(project({ openFiles: [], commands: [], lastTest: null, pinnedNotes: [], repo: undefined, activeBranch: undefined }));
  assert.ok(context.startsWith("Previously…"));
  assert.match(context, /Continue this project/);
  assert.ok(context.length < 600);
});
