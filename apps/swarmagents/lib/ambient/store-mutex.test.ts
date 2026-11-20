import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureAmbientStore, loadRules, saveRules, withLockedRules } from "./store";
import type { AmbientRule } from "./types";

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-ambient-mutex-test-"));
  configureAmbientStore(dir);
});

test.afterEach(() => {
  configureAmbientStore("");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ambient-rules.json is written with 0o600 permissions", () => {
  const rule: AmbientRule = {
    id: "rule1",
    userId: "alice",
    roleId: "main",
    kind: "webhook",
    webhookSecret: "secret123",
    prompt: "Test prompt",
    toolAllowlist: ["Read"],
    enabled: true,
  };
  saveRules([rule]);

  const filePath = path.join(dir, "ambient-rules.json");
  const stat = fs.statSync(filePath);
  // Mode on POSIX systems: lower 9 bits
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, `Expected 0o600, got 0o${mode.toString(8)}`);
});

test("concurrent saveRules / withLockedRules calls do not collide or lose updates", async () => {
  const count = 25;
  const initialRules: AmbientRule[] = [];
  saveRules(initialRules);

  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      withLockedRules(async (rules) => {
        // Small delay to simulate work under lock
        await new Promise((r) => setTimeout(r, 2));
        const updated = [...rules, {
          id: `rule_${i}`,
          userId: "alice",
          roleId: "main",
          kind: "webhook",
          prompt: `Prompt ${i}`,
          toolAllowlist: [],
          enabled: true,
        } as AmbientRule];
        saveRules(updated);
      })
    )
  );

  const finalRules = loadRules();
  assert.equal(finalRules.length, count);
  const ids = new Set(finalRules.map((r) => r.id));
  assert.equal(ids.size, count);
});
