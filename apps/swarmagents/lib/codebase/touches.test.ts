import test from "node:test";
import assert from "node:assert/strict";
import { extractTouchedPaths, normalizeTouchedPath } from "./touches";

test("normalizeTouchedPath keeps workspace-relative paths", () => {
  assert.equal(normalizeTouchedPath("/workspace/src/a.ts"), "src/a.ts");
  assert.equal(normalizeTouchedPath("src/a.ts"), "src/a.ts");
  assert.equal(normalizeTouchedPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeTouchedPath(""), null);
  assert.equal(normalizeTouchedPath("/etc/passwd"), null);
  assert.equal(normalizeTouchedPath("/workspace/../etc/passwd"), null);
});

test("extractTouchedPaths finds the files of a write tool call", () => {
  const paths = extractTouchedPaths({ file_path: "/workspace/src/app.ts", content: "x" });
  assert.deepEqual(paths, ["src/app.ts"]);
});

test("extractTouchedPaths finds the files a shell command mentions", () => {
  const paths = extractTouchedPaths({ command: "cd /workspace && npx tsc lib/a.ts lib/b.ts" });
  assert.ok(paths.includes("lib/a.ts"));
  assert.ok(paths.includes("lib/b.ts"));
});

test("extractTouchedPaths walks nested tool arguments", () => {
  const paths = extractTouchedPaths({
    edits: [{ path: "/workspace/deep/nested/file.ts" }],
    meta: { target: { targetPath: "/workspace/other.ts" } },
  });
  assert.ok(paths.includes("deep/nested/file.ts"));
  assert.ok(paths.includes("other.ts"));
});

test("extractTouchedPaths ignores arguments that are not paths", () => {
  const paths = extractTouchedPaths({ prompt: "fix the bug in src/app.ts please", timeout: 30 });
  assert.deepEqual(paths, []);
});
