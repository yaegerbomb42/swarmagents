/**
 * Per-account installed library: storage layout, file permissions, secret
 * sealing (values never leave the server in clear), item validation and the
 * copy-preserving update paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addInstalledItem,
  configureLibraryStoreDir,
  deleteInstalledItem,
  getInstalledItem,
  getStoredItem,
  installedItemSecrets,
  installedItemView,
  listInstalledItems,
  maskSecret,
  normalizeSecretValues,
  publicInstallId,
  readUserLibrary,
  replaceInstalledCopy,
  resolveLibraryDataDir,
  userLibraryFilePath,
} from "./user-store";
import { LibraryError } from "./types";

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-library-user-"));
  configureLibraryStoreDir(dir);
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function skillPayload(markdown = "# Skill", fields: Array<{ key: string; label: string }> = []) {
  return { kind: "skill" as const, skillMd: markdown, files: [], requiredFields: fields };
}

function toolPayload(fields: Array<{ key: string; label: string }> = []) {
  return {
    kind: "tool" as const,
    language: "javascript" as const,
    code: "return 1;",
    inputSchema: { type: "object", properties: {} },
    requiredFields: fields,
    timeoutMs: 5000,
  };
}

function expectLibraryError(fn: () => unknown, status = 400, pattern?: RegExp): LibraryError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LibraryError, `expected LibraryError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected the call to throw");
}

test("the library root is the configured data dir and user ids are validated", () => {
  assert.equal(resolveLibraryDataDir(), dir);
  assert.ok(userLibraryFilePath("alice").startsWith(path.join(dir, "users")));
  assert.equal(userLibraryFilePath("alice"), userLibraryFilePath("alice"));
  assert.notEqual(userLibraryFilePath("alice"), userLibraryFilePath("bob"));
  expectLibraryError(() => userLibraryFilePath(""), 401, /signed-in user/);
  expectLibraryError(() => userLibraryFilePath("x".repeat(257)), 401, /signed-in user/);
});

test("addInstalledItem stores a normalized item and returns a client-safe view", () => {
  const view = addInstalledItem("alice", {
    kind: "skill",
    name: "  Runbook  ",
    description: "  Ops runbook  ",
    license: " MIT ",
    payload: skillPayload("# Runbook"),
  });
  assert.match(view.id, /^skill-runbook-[a-f0-9]{8}$/);
  assert.equal(view.name, "Runbook");
  assert.equal(view.description, "Ops runbook");
  assert.equal(view.license, "MIT");
  assert.equal(view.origin, "user");
  assert.equal(view.version, 1);
  assert.deepEqual((view.payload as any).skillMd, "# Runbook");
  assert.equal(view.secretFields.length, 0);

  const listed = listInstalledItems("alice");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], view);
  assert.deepEqual(getInstalledItem("alice", view.id), view);
  assert.equal(getInstalledItem("alice", "missing"), null);
  assert.equal(getInstalledItem("bob", view.id), null, "libraries are scoped per account");
});

test("item files and directories are private (0700 dir, 0600 file)", () => {
  const view = addInstalledItem("alice", { kind: "skill", name: "Private", payload: skillPayload() });
  const file = userLibraryFilePath("alice");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, "utf-8").includes(view.name), true);
});

test("secrets are sealed at rest and exposed only as configured/mask metadata", () => {
  const value = "test-only-tool-secret-1234";
  const view = addInstalledItem("alice", {
    kind: "tool",
    name: "Secret tool",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: value },
  });

  assert.equal(view.secretFields.length, 1);
  assert.equal(view.secretFields[0].key, "TOKEN");
  assert.equal(view.secretFields[0].configured, true);
  assert.equal(view.secretFields[0].mask, "••••1234");
  assert.equal(JSON.stringify(view).includes(value), false, "the view never carries the value");

  const raw = fs.readFileSync(userLibraryFilePath("alice"), "utf-8");
  assert.equal(raw.includes(value), false, "the value is encrypted at rest");

  const stored = getStoredItem("alice", view.id)!;
  assert.notEqual(stored.sealedSecrets.TOKEN, value);
  assert.deepEqual(installedItemSecrets("alice", stored), { TOKEN: value });
});

test("maskSecret keeps only the last four characters", () => {
  assert.equal(maskSecret("abc"), "••••");
  assert.equal(maskSecret("abcd"), "••••");
  assert.equal(maskSecret("abcde"), "••••bcde");
  assert.equal(maskSecret("1234567890"), "••••7890");
});

test("normalizeSecretValues reports missing fields and enforces string/length", () => {
  const fields = [{ key: "A", label: "A" }, { key: "B", label: "B" }];
  const missing = expectLibraryError(() => normalizeSecretValues(fields, { A: "x" }), 400, /Missing required/);
  assert.deepEqual(missing.details, { missingFields: ["B"] });
  expectLibraryError(() => normalizeSecretValues(fields, { A: 1 as unknown as string, B: "y" }), 400, /must be a string/);
  expectLibraryError(() => normalizeSecretValues(fields, { A: "x".repeat(4097), B: "y" }), 400, /too long/);
  expectLibraryError(() => normalizeSecretValues(fields, [] as unknown as Record<string, string>), 400, /must be an object/);
  assert.deepEqual(normalizeSecretValues(fields, { A: "x", B: "y" }), { A: "x", B: "y" });
  assert.deepEqual(normalizeSecretValues([], undefined), {});
});

test("re-adding an item keeps secrets the caller does not resupply", () => {
  const first = addInstalledItem("alice", {
    id: "tool-fixed",
    kind: "tool",
    name: "Fixed",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "first-value-1111" },
  });
  const createdAt = first.createdAt;

  const second = addInstalledItem("alice", {
    id: "tool-fixed",
    kind: "tool",
    name: "Fixed renamed",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
  });
  assert.equal(second.name, "Fixed renamed");
  assert.equal(second.version, 1, "editing does not bump the installed version");
  assert.equal(second.createdAt, createdAt);
  assert.equal(second.secretFields[0].configured, true);
  assert.deepEqual(installedItemSecrets("alice", getStoredItem("alice", "tool-fixed")!), {
    TOKEN: "first-value-1111",
  });

  // A value resupplied for an already-configured field rotates the sealed
  // secret: validated like a fresh one, re-sealed, old value superseded.
  addInstalledItem("alice", {
    id: "tool-fixed",
    kind: "tool",
    name: "Fixed renamed",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "second-value-2222" },
  });
  assert.deepEqual(installedItemSecrets("alice", getStoredItem("alice", "tool-fixed")!), {
    TOKEN: "second-value-2222",
  });
  const raw = fs.readFileSync(userLibraryFilePath("alice"), "utf-8");
  assert.equal(raw.includes("first-value-1111"), false);
  assert.equal(raw.includes("second-value-2222"), false);
  const rotated = getStoredItem("alice", "tool-fixed")!;
  assert.equal(rotated.secretMasks.TOKEN, "••••2222");
});

test("a resupplied secret is validated like a fresh one", () => {
  const first = addInstalledItem("alice", {
    id: "tool-fixed",
    kind: "tool",
    name: "Fixed",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "first-value-1111" },
  });

  const missing = expectLibraryError(
    () =>
      addInstalledItem("alice", {
        id: "tool-fixed",
        kind: "tool",
        name: "Fixed",
        payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
        secrets: { TOKEN: "" },
      }),
    400,
    /Missing required/,
  );
  assert.deepEqual(missing.details, { missingFields: ["TOKEN"] });

  expectLibraryError(
    () =>
      addInstalledItem("alice", {
        id: "tool-fixed",
        kind: "tool",
        name: "Fixed",
        payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
        secrets: { TOKEN: 7 as unknown as string },
      }),
    400,
    /must be a string/,
  );
  expectLibraryError(
    () =>
      addInstalledItem("alice", {
        id: "tool-fixed",
        kind: "tool",
        name: "Fixed",
        payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
        secrets: { TOKEN: "x".repeat(4097) },
      }),
    400,
    /too long/,
  );
  // None of the failed re-adds replaced the stored secret.
  assert.deepEqual(installedItemSecrets("alice", getStoredItem("alice", "tool-fixed")!), {
    TOKEN: "first-value-1111",
  });
  assert.equal(first.version, 1);
});

test("replaceInstalledCopy rotates a resupplied secret", () => {
  addInstalledItem("alice", {
    id: "pub-rotated",
    kind: "tool",
    name: "Rotatable copy",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "copy-value-1111" },
  });
  const updated = replaceInstalledCopy("alice", {
    id: "pub-rotated",
    kind: "tool",
    name: "Rotatable copy",
    description: "",
    version: 1,
    sourcePublicId: "pub_rotate",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "copy-value-2222" },
  });
  assert.equal(updated.secretFields[0].mask, "••••2222");
  assert.deepEqual(installedItemSecrets("alice", getStoredItem("alice", "pub-rotated")!), {
    TOKEN: "copy-value-2222",
  });
});

test("a broken or foreign sealed secret is skipped instead of failing the library", () => {
  const view = addInstalledItem("alice", {
    kind: "tool",
    name: "Broken",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "valid-value-9999" },
  });
  const stored = getStoredItem("alice", view.id)!;
  stored.sealedSecrets.TOKEN = "not-a-real-sealed-value";
  assert.deepEqual(installedItemSecrets("alice", stored), {});
});

test("addInstalledItem rejects invalid names, kinds, ids and payloads", () => {
  expectLibraryError(() => addInstalledItem("alice", { kind: "nope" as any, name: "x", payload: skillPayload() }));
  expectLibraryError(() => addInstalledItem("alice", { kind: "skill", name: "   ", payload: skillPayload() }), 400, /name is required/);
  expectLibraryError(
    () => addInstalledItem("alice", { kind: "skill", name: "x".repeat(121), payload: skillPayload() }),
    400,
    /at most 120/,
  );
  expectLibraryError(
    () => addInstalledItem("alice", { kind: "skill", name: "x", description: 1 as unknown as string, payload: skillPayload() }),
    400,
    /description/,
  );
  expectLibraryError(
    () => addInstalledItem("alice", { kind: "skill", name: "x", license: "x".repeat(81), payload: skillPayload() }),
    400,
    /license/,
  );
  expectLibraryError(
    () => addInstalledItem("alice", { kind: "skill", name: "x", id: "../evil", payload: skillPayload() }),
    400,
    /safe item id/,
  );
  expectLibraryError(
    () => addInstalledItem("alice", { kind: "skill", name: "x", payload: { kind: "skill" } }),
    400,
    /skillMd/,
  );
});

test("an item that is re-added keeps its origin and source public id", () => {
  const installed = replaceInstalledCopy("alice", {
    id: "pub-abc",
    kind: "skill",
    name: "From public",
    description: "Copied",
    version: 2,
    sourcePublicId: "pub_original",
    payload: skillPayload("# v2"),
  });
  assert.equal(installed.origin, "public");
  assert.equal(installed.version, 2);
  assert.equal(installed.sourcePublicId, "pub_original");

  const edited = addInstalledItem("alice", {
    id: "pub-abc",
    kind: "skill",
    name: "From public edited",
    payload: skillPayload("# edited"),
  });
  assert.equal(edited.origin, "public");
  assert.equal(edited.sourcePublicId, "pub_original");
  assert.equal(edited.version, 2);
});

test("replaceInstalledCopy normalizes the payload and preserves existing secrets", () => {
  const first = replaceInstalledCopy("alice", {
    id: "pub-secret",
    kind: "tool",
    name: "Secret copy",
    description: "",
    version: 1,
    sourcePublicId: "pub_s",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "copy-secret-7777" },
  });
  assert.equal(first.secretFields[0].configured, true);

  const second = replaceInstalledCopy("alice", {
    id: "pub-secret",
    kind: "tool",
    name: "Secret copy v2",
    description: "new",
    version: 2,
    sourcePublicId: "pub_s",
    payload: { kind: "tool", code: "return 2;" } as any,
  });
  assert.equal(second.version, 2);
  assert.equal((second.payload as any).timeoutMs, 30_000, "payload is normalized");
  assert.deepEqual(installedItemSecrets("alice", getStoredItem("alice", "pub-secret")!), {
    TOKEN: "copy-secret-7777",
  });
});

test("deleteInstalledItem removes one item and reports whether it existed", () => {
  const view = addInstalledItem("alice", { kind: "skill", name: "Gone", payload: skillPayload() });
  assert.equal(deleteInstalledItem("alice", view.id), true);
  assert.equal(deleteInstalledItem("alice", view.id), false);
  assert.equal(listInstalledItems("alice").length, 0);
});

test("publicInstallId is stable, prefixed and distinct per public item", () => {
  const a = publicInstallId("pub_one");
  assert.equal(a, publicInstallId("pub_one"));
  assert.match(a, /^pub-[a-f0-9]{12}$/);
  assert.notEqual(a, publicInstallId("pub_two"));
});

test("corrupt, foreign and partially invalid library files read safely", () => {
  const file = userLibraryFilePath("alice");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(readUserLibrary("alice").items, []);

  fs.writeFileSync(file, JSON.stringify({ schema: "x", version: 1, userId: "bob", items: [] }));
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(readUserLibrary("alice").items, [], "another account's file is ignored");
  } finally {
    console.error = originalError;
  }

  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: "x",
      version: 1,
      userId: "alice",
      items: [
        { id: "bad-kind", kind: "nope", payload: {} },
        { id: "bad-payload", kind: "skill", payload: { kind: "skill" } },
        { id: "good", kind: "skill", name: "Good", payload: skillPayload("# good") },
      ],
    }),
  );
  const items = readUserLibrary("alice").items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "good");
  assert.equal(items[0].name, "Good");
});

test("installedItemView strips server-only fields", () => {
  const view = addInstalledItem("alice", {
    kind: "tool",
    name: "Stripped",
    payload: toolPayload([{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "strip-me-1234" },
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("sealedSecrets"), false);
  assert.equal(serialized.includes("secretMasks"), false);
  assert.equal(serialized.includes("strip-me-1234"), false);
  const stored = getStoredItem("alice", view.id)!;
  assert.equal(installedItemView(stored).id, view.id);
});
