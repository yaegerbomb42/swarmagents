import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureLibraryStoreDir, listInstalledItems } from "../library/user-store";
import { configureProviderStorePaths } from "../providers/store";
import {
  compactConnectorCatalog,
  generateCustomToolMcpWrapper,
  registerAuthoredToolInLibrary,
  validateAuthorToolInput,
} from "./tool-author";

let tmpDir = "";

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tool-author-"));
  configureProviderStorePaths(path.join(tmpDir, "providers.json"));
  configureLibraryStoreDir(tmpDir);
});

test.afterEach(() => {
  configureProviderStorePaths("");
  configureLibraryStoreDir(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("validateAuthorToolInput rejects hardcoded secrets and invalid slugs", () => {
  assert.throws(
    () =>
      validateAuthorToolInput({
        id: "../bad",
        name: "Bad",
        description: "Bad slug test",
        runtime: "node",
        code: "console.log(1)",
      }),
    /Tool id/,
  );

  assert.throws(
    () =>
      validateAuthorToolInput({
        id: "leaky-tool",
        name: "Leaky Tool",
        description: "Contains a secret",
        runtime: "node",
        code: 'const key = "ghp_1234567890abcdefghijklmnop123456";',
      }),
    /secret/,
  );
});

test("registerAuthoredToolInLibrary persists agent-authored tool and generates wrapper", () => {
  const item = registerAuthoredToolInLibrary("alice", {
    id: "json-pretty",
    name: "JSON Prettifier",
    description: "Formats JSON strings cleanly inside the VM.",
    runtime: "node",
    code: 'console.log(JSON.stringify(JSON.parse(process.env.SWARM_TOOL_INPUT || "{}"), null, 2));',
  });
  assert.equal(item.id, "custom-json-pretty");
  assert.equal(item.origin, "agent");
  assert.equal(listInstalledItems("alice").length, 1);

  const wrapper = generateCustomToolMcpWrapper({
    id: "json-pretty",
    name: "JSON Prettifier",
    description: "Formats JSON strings cleanly inside the VM.",
    runtime: "node",
    scriptPath: "/workspace/.swarm/custom-tools/json-pretty/tool.mjs",
    argsDescription: "JSON string",
  });
  assert.match(wrapper, /tools\/call/);
  assert.ok(compactConnectorCatalog().length >= 40);
});
