import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "../providers/store";
import {
  AUTO_MEMORY_TOKEN_BUDGET,
  clearMemories,
  forgetMemory,
  formatMemoriesForInjection,
  listMemories,
  memoryContextForPrompt,
  memoryRecallForPrompt,
  readMemoryFile,
  searchMemories,
  userMemoryFilePath,
  writeMemory,
} from "./store";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-memory-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

test("write/search/forget memories are per-user and survive re-read", async () => {
  const m = await writeMemory(ALICE, { fact: "prefers tabs over spaces", tags: ["preference"] });
  assert.match(m.id, /^mem_/);
  assert.deepEqual(listMemories(ALICE).map((x) => x.fact), ["prefers tabs over spaces"]);
  assert.deepEqual(listMemories(BOB), []);
  const hits = await searchMemories(ALICE, "tabs spaces", { k: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, m.id);
  assert.equal((await searchMemories(BOB, "tabs", { k: 5 })).length, 0);
  assert.equal(forgetMemory(BOB, m.id), false);
  assert.equal(forgetMemory(ALICE, m.id), true);
  assert.deepEqual(listMemories(ALICE), []);
});

test("memory redacts secret-like material before saving", async () => {
  const fake = "sk-FAKE-OPENAI-KEY-0123456789ABCDEF01234567";
  const m = await writeMemory(ALICE, { fact: `use token ${fake} for tests`, tags: ["preference"] });
  assert.ok(!m.fact.includes(fake));
  assert.match(m.fact, /\[REDACTED\]/);
  const onDisk = readFileSync(userMemoryFilePath(ALICE), "utf8");
  assert.ok(!onDisk.includes(fake), "secret leaked to disk");
});

test("clearMemories removes all facts for the user only", async () => {
  await writeMemory(ALICE, { fact: "a", tags: ["preference"] });
  await writeMemory(BOB, { fact: "b", tags: ["preference"] });
  assert.equal(clearMemories(ALICE), 1);
  assert.deepEqual(listMemories(ALICE), []);
  assert.equal(listMemories(BOB).length, 1);
});

test("search ranks relevant facts and formats injection within budget", async () => {
  await writeMemory(ALICE, { fact: "prefers pnpm for package management", tags: ["preference"] });
  await writeMemory(ALICE, { fact: "repo uses vitest for unit tests", tags: ["codebase:abc"] });
  const hits = await searchMemories(ALICE, "package manager pnpm", { k: 5 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].fact, /pnpm/);
  const text = formatMemoriesForInjection(hits, 1000);
  assert.match(text, /Long-term memory/);
  assert.match(text, /pnpm/);
  const tiny = formatMemoriesForInjection(hits, 5);
  assert.equal(tiny, "");
});

test("at most five memories are injected", async () => {
  for (let i = 0; i < 8; i++) {
    await writeMemory(ALICE, { fact: `preference number ${i} about the editor theme`, tags: ["preference"] });
  }
  const context = await memoryContextForPrompt(ALICE, "editor theme");
  const lines = context.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 5);
});

test("an unrelated prompt still gets the newest memories injected", async () => {
  await writeMemory(ALICE, { fact: "I prefer pnpm over npm for package management", tags: ["preference"] });
  // The words are disjoint, so the keyword search finds nothing; the newest
  // facts are injected so the agent still starts the run knowing them.
  const context = await memoryContextForPrompt(ALICE, "what is the weather like");
  assert.match(context, /pnpm/);
});

test("the injection block stays inside the token budget", async () => {
  for (let i = 0; i < 20; i++) {
    await writeMemory(ALICE, { fact: `preference ${i}: ${"x".repeat(400)}`, tags: ["preference"] });
  }
  const context = await memoryContextForPrompt(ALICE, "preference");
  assert.ok(context.length > 0);
  assert.ok(Math.ceil(context.length / 4) <= 1000, "injection exceeded the 1k token budget");
});

test("readMemoryFile ignores a file owned by another user id", async () => {
  await writeMemory(ALICE, { fact: "alice only", tags: [] });
  // Rewrite Alice's file as if it belonged to Bob: the owner check inside the
  // file keeps it from being served.
  const aliceFile = userMemoryFilePath(ALICE);
  const raw = JSON.parse(readFileSync(aliceFile, "utf8")) as { userId: string };
  raw.userId = BOB;
  writeFileSync(aliceFile, JSON.stringify(raw), "utf8");
  assert.deepEqual(readMemoryFile(ALICE).facts, []);
});

test("the same fact is stored once", async () => {
  const first = await writeMemory(ALICE, { fact: "prefers dark mode", tags: ["preference"] });
  const second = await writeMemory(ALICE, { fact: "prefers dark mode", tags: ["preference"] });
  assert.equal(first.id, second.id);
  assert.equal(listMemories(ALICE).length, 1);
});

test("tags are normalized and bounded", async () => {
  const memory = await writeMemory(ALICE, {
    fact: "the deploy pipeline runs on fridays",
    tags: ["task-pattern", " task-pattern ", "x".repeat(200), 42, "preference"],
  });
  assert.deepEqual(memory.tags, ["task-pattern", "preference"]);
});

test("memoryRecallForPrompt caps auto-recall at AUTO_MEMORY_TOKEN_BUDGET (300 tokens) and returns count/tokens", async () => {
  for (let i = 0; i < 6; i++) {
    await writeMemory(ALICE, {
      fact: `Preference ${i}: always use strict TypeScript and run affected tests before pushing ${"x".repeat(160)}`,
      tags: ["preference"],
    });
  }
  const recalled = await memoryRecallForPrompt(ALICE, "typescript tests", {
    budgetTokens: AUTO_MEMORY_TOKEN_BUDGET,
  });
  assert.ok(recalled.count > 0);
  assert.ok(recalled.tokens <= AUTO_MEMORY_TOKEN_BUDGET, `expected <= ${AUTO_MEMORY_TOKEN_BUDGET}, got ${recalled.tokens}`);
  assert.ok(recalled.text.length > 0);
});
