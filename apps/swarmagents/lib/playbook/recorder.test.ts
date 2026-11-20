import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureLibraryStoreDir } from "../library/user-store";
import { PlaybookRecorder, compileTrace, runCompiledPlaybook, savePlaybookToLibrary } from "./recorder";

test("record, compile, and run a parameterized playbook", () => {
  const recorder = new PlaybookRecorder();
  recorder.recordPlaywright("browser_navigate", { url: "https://portal.example/login" });
  recorder.recordShell("echo report-ready");
  recorder.recordDesktop("click", { x: 10, y: 20 });

  const playbook = compileTrace(recorder.trace(), {
    name: "Portal report",
    description: "Open the portal and mark the report ready.",
  });

  assert.equal(playbook.parameters.length, 1);
  assert.equal(playbook.parameters[0]?.example, "https://portal.example/login");
  assert.equal(playbook.steps[0]?.input.url, `{{${playbook.parameters[0]?.key}}}`);
  assert.doesNotMatch(playbook.payload.skillMd, /portal\.example/);
  assert.match(playbook.payload.skillMd, /PreToolUse/);
  assert.ok(playbook.bounds.every((bound) => bound.level === "allow" || bound.level === "ask" || bound.level === "deny"));

  const url = "https://portal.example/login";
  const key = playbook.parameters[0]?.key ?? "";
  const result = runCompiledPlaybook(playbook, { [key]: url }, { exec: true });
  assert.equal(result.output, "report-ready");
  assert.equal(result.steps[0]?.input.url, url);
  assert.equal(result.steps[1]?.executed, true);
  assert.equal(result.steps[2]?.executed, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-lib-"));
  configureLibraryStoreDir(dir);
  try {
    const saved = savePlaybookToLibrary("user-f13", playbook);
    assert.equal(saved.kind, "skill");
    assert.equal(saved.name, "Portal report");
    assert.match((saved.payload as { skillMd: string }).skillMd, /preToolUseMax/);
  } finally {
    configureLibraryStoreDir(undefined);
  }
});

test("compiled playbook refuses a step the classifier denies", () => {
  const recorder = new PlaybookRecorder();
  recorder.recordShell("cat /etc/shadow");
  const playbook = compileTrace(recorder.trace(), { name: "Unsafe" });
  assert.equal(playbook.maxLevel, "deny");
  assert.throws(() => runCompiledPlaybook(playbook, {}, { exec: true }), /PreToolUse deny/);
});

test("secret assignments become parameters, not literals", () => {
  const recorder = new PlaybookRecorder();
  recorder.recordShell("echo --password=s3cret-value");
  const playbook = compileTrace(recorder.trace(), { name: "Login" });
  assert.equal(playbook.parameters[0]?.secret, true);
  assert.equal(playbook.payload.requiredFields[0]?.key, playbook.parameters[0]?.key);
  assert.doesNotMatch(playbook.payload.skillMd, /s3cret-value/);
  assert.doesNotMatch(playbook.payload.files[0]?.content ?? "", /s3cret-value/);
});
