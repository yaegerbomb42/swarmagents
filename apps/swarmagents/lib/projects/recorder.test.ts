import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  branchFromCommand,
  isTestCommand,
  noteProjectRunEvent,
  parseTestOutput,
  resetProjectRecorder,
} from "./recorder";
import { configureProjectStoreDir, createProject, getProject, MAX_COMMANDS } from "./store";

function withProject(fn: (projectId: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-recorder-"));
  configureProjectStoreDir(dir);
  resetProjectRecorder();
  try {
    const project = createProject("alice", { name: "Recorder" });
    fn(project.id);
  } finally {
    resetProjectRecorder();
    configureProjectStoreDir("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("recorder: Bash calls and results become commands with exit codes and branches", () => {
  withProject((projectId) => {
    noteProjectRunEvent("alice", projectId, "run_1", {
      type: "tool.call",
      name: "Bash",
      id: "tool_1",
      input: { command: "git checkout -b feat/new-branch" },
    });
    noteProjectRunEvent("alice", projectId, "run_1", {
      type: "tool.result",
      id: "tool_1",
      ok: true,
      output: "",
    });
    noteProjectRunEvent("alice", projectId, "run_1", {
      type: "tool.call",
      name: "Bash",
      id: "tool_2",
      input: { command: "npm test" },
    });
    noteProjectRunEvent("alice", projectId, "run_1", {
      type: "tool.result",
      id: "tool_2",
      ok: false,
      output: "Tests: 1 failed, 4 passed, 5 total\nFAIL lib/a.test.ts\nEXIT CODE: 1",
    });

    const project = getProject("alice", projectId);
    assert.ok(project);
    assert.equal(project.activeBranch, "feat/new-branch");
    assert.equal(project.commands.length, 2);
    assert.equal(project.commands[0].command, "git checkout -b feat/new-branch");
    assert.equal(project.commands[0].exitCode, 0);
    assert.equal(project.commands[1].command, "npm test");
    assert.equal(project.commands[1].exitCode, 1);
    assert.equal(project.lastTest?.ok, false);
    assert.equal(project.lastTest?.passed, 4);
    assert.equal(project.lastTest?.failed, 1);
    assert.deepEqual(project.lastTest?.failing, ["FAIL lib/a.test.ts"]);
  });
});

test("recorder: open files are newest-first, de-duplicated and capped", () => {
  withProject((projectId) => {
    for (let index = 0; index < 60; index++) {
      noteProjectRunEvent("alice", projectId, "run_1", {
        type: "tool.call",
        name: index % 2 === 0 ? "Read" : "Edit",
        input: { file_path: `apps/swarmagents/file-${index}.ts` },
      });
    }
    noteProjectRunEvent("alice", projectId, "run_1", {
      type: "tool.call",
      name: "Read",
      input: { file_path: "apps/swarmagents/file-59.ts" },
    });
    const project = getProject("alice", projectId);
    assert.ok(project);
    assert.equal(project.openFiles.length, 50);
    assert.equal(project.openFiles[0], "apps/swarmagents/file-59.ts");
    assert.equal(new Set(project.openFiles).size, project.openFiles.length);
  });
});

test("recorder: commands are capped at the last twenty", () => {
  withProject((projectId) => {
    for (let index = 0; index < 25; index++) {
      noteProjectRunEvent("alice", projectId, "run_1", {
        type: "tool.call",
        name: "Bash",
        id: `tool_${index}`,
        input: { command: `echo ${index}` },
      });
      noteProjectRunEvent("alice", projectId, "run_1", {
        type: "tool.result",
        id: `tool_${index}`,
        ok: true,
        output: "",
      });
    }
    const project = getProject("alice", projectId);
    assert.ok(project);
    assert.equal(project.commands.length, MAX_COMMANDS);
    assert.equal(project.commands.at(-1)?.command, "echo 24");
  });
});

test("recorder: run.started attaches the thread once", () => {
  withProject((projectId) => {
    noteProjectRunEvent("alice", projectId, "run_1", { type: "run.started", sessionId: "sess_1" });
    noteProjectRunEvent("alice", projectId, "run_2", { type: "run.started", sessionId: "sess_1" });
    noteProjectRunEvent("alice", projectId, "run_3", { type: "run.finished", sessionId: "sess_2" });
    const project = getProject("alice", projectId);
    assert.deepEqual(project?.threads, ["sess_1", "sess_2"]);
  });
});

test("recorder: test command and output parsing helpers", () => {
  assert.equal(isTestCommand("npm test"), true);
  assert.equal(isTestCommand("cd apps/swarmagents && npx vitest run"), true);
  assert.equal(isTestCommand("python -m pytest -q"), true);
  assert.equal(isTestCommand("go test ./..."), true);
  assert.equal(isTestCommand("ls -la"), false);

  assert.equal(branchFromCommand("git switch -c fix/thing"), "fix/thing");
  assert.equal(branchFromCommand("git checkout main"), "main");
  assert.equal(branchFromCommand("git checkout -- src/app.ts"), undefined);
  assert.equal(branchFromCommand("npm test"), undefined);

  const parsed = parseTestOutput("# pass 12\n# fail 2\nnot ok 13 - works\nFAIL lib/x.test.ts\n");
  assert.equal(parsed.passed, 12);
  assert.equal(parsed.failed, 2);
  assert.equal(parsed.failing.length, 2);
});
