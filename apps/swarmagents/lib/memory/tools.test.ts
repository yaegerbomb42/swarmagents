import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "../providers/store";
import { listMemories } from "./store";
import { MEMORY_TOOL_SCHEMAS, runMemoryTool } from "./tools";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-memory-tools-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

test("the three memory tools are advertised", () => {
  assert.deepEqual(
    MEMORY_TOOL_SCHEMAS.map((tool) => tool.name),
    ["memory_write", "memory_search", "memory_forget"],
  );
  for (const tool of MEMORY_TOOL_SCHEMAS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 10);
  }
});

test("memory_write stores a fact, memory_search finds it, memory_forget removes it", async () => {
  const written = await runMemoryTool(ALICE, "memory_write", {
    fact: "the user prefers dark mode",
    tags: ["preference"],
  });
  assert.equal(written.ok, true);
  assert.match(written.fact?.id ?? "", /^mem_/);
  assert.deepEqual(written.fact?.tags, ["preference"]);

  const found = await runMemoryTool(ALICE, "memory_search", { query: "dark mode", k: 3 });
  assert.equal(found.ok, true);
  assert.equal(found.memories?.length, 1);
  assert.match(found.memories?.[0].fact ?? "", /dark mode/);

  const forgotten = await runMemoryTool(ALICE, "memory_forget", { id: written.fact?.id });
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.forgotten, 1);
  assert.deepEqual(listMemories(ALICE), []);
});

test("the memory tools never reach another account", async () => {
  const written = await runMemoryTool(ALICE, "memory_write", { fact: "alice's private note" });
  assert.equal(written.ok, true);

  const bobSearch = await runMemoryTool(BOB, "memory_search", { query: "private note" });
  assert.equal(bobSearch.ok, true);
  assert.equal(bobSearch.memories?.length, 0);

  const bobForget = await runMemoryTool(BOB, "memory_forget", { id: written.fact?.id });
  assert.equal(bobForget.ok, false);
  assert.equal(bobForget.error, "not_found");
  assert.equal(listMemories(ALICE).length, 1, "another account removed the memory");
});

test("bad tool input comes back as an error, never as a throw", async () => {
  const noFact = await runMemoryTool(ALICE, "memory_write", {});
  assert.equal(noFact.ok, false);
  assert.equal(noFact.error, "invalid_input");

  const noQuery = await runMemoryTool(ALICE, "memory_search", { query: "  " });
  assert.equal(noQuery.ok, false);
  assert.equal(noQuery.error, "invalid_input");

  const noId = await runMemoryTool(ALICE, "memory_forget", {});
  assert.equal(noId.ok, false);
  assert.equal(noId.error, "invalid_input");

  const unknown = await runMemoryTool(ALICE, "memory_nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown_tool");
});

test("a memory written through the tool is redacted before it is stored", async () => {
  const fake = "sk-FAKE-TOOL-KEY-0123456789ABCDEF0123456789";
  const written = await runMemoryTool(ALICE, "memory_write", { fact: `the token is ${fake}` });
  assert.equal(written.ok, true);
  assert.ok(!(written.fact?.fact ?? "").includes(fake));
  assert.match(written.fact?.fact ?? "", /\[REDACTED\]/);
});
