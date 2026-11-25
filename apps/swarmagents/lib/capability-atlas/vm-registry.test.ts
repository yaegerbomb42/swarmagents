import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { containsSecretValue } from "../agents/export-secrets";
import { configureLibraryStoreDir } from "../library/user-store";
import { configureProviderStorePaths } from "../providers/store";
import { buildUserVmAtlasEntries, serializeUserVmAtlasRegistry } from "./vm-registry";

let tmpDir = "";

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-vm-atlas-"));
  configureProviderStorePaths(path.join(tmpDir, "providers.json"));
  configureLibraryStoreDir(tmpDir);
});

test.afterEach(() => {
  configureProviderStorePaths("");
  configureLibraryStoreDir(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildUserVmAtlasEntries indexes all 40+ connectors and core CLIs without leaking secrets", () => {
  const entries = buildUserVmAtlasEntries("alice");
  assert.ok(entries.length >= 45, `expected >= 45 entries, got ${entries.length}`);
  assert.ok(entries.some((e) => e.id === "mcp:tool-forge"));
  assert.ok(entries.some((e) => e.id === "connector:slack"));
  assert.ok(entries.some((e) => e.id === "connector:postgres"));

  const serialized = serializeUserVmAtlasRegistry("alice");
  assert.equal(containsSecretValue(serialized), false);
  const parsed = JSON.parse(serialized) as { schema: string; entries: unknown[] };
  assert.equal(parsed.schema, "swarm.capability-atlas");
  assert.equal(parsed.entries.length, entries.length);
});
