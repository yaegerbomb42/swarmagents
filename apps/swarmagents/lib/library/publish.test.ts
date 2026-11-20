/**
 * Publishing input resolution: secrets are rejected, a source item copies
 * payload + field names only, and inline payloads pass the secret scanner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addInstalledItem, configureLibraryStoreDir } from "./user-store";
import { resolvePublishInput } from "./publish";
import { LibraryError } from "./types";

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-library-publish-"));
  configureLibraryStoreDir(dir);
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function skill(markdown = "# Skill", fields: Array<{ key: string; label: string }> = []) {
  return { kind: "skill" as const, skillMd: markdown, files: [], requiredFields: fields };
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

test("resolvePublishInput rejects non-object bodies", () => {
  for (const body of [null, undefined, "x", 1, []]) {
    expectLibraryError(() => resolvePublishInput("alice", body), 400, /Body must be an object/);
  }
});

test("resolvePublishInput rejects secret containers at the top level", () => {
  for (const key of ["secrets", "secretValues", "env"]) {
    expectLibraryError(
      () => resolvePublishInput("alice", { kind: "skill", name: "x", payload: skill(), [key]: { TOKEN: "x" } }),
      400,
      /Secrets cannot be published/,
    );
  }
});

test("resolvePublishInput rejects secret-shaped keys inside an inline payload", () => {
  for (const payload of [
    { kind: "skill", skillMd: "# x", token: "abc" },
    { kind: "skill", skillMd: "# x", password: "abc" },
    { kind: "skill", skillMd: "# x", nested: { api_key: "abc" } },
    { kind: "skill", skillMd: "# x", headers: { A: "b" } },
  ]) {
    expectLibraryError(
      () => resolvePublishInput("alice", { kind: "skill", name: "x", payload }),
      400,
      /secret material/,
    );
  }
});

test("sourceItemId must be a string and must exist in the caller's own library", () => {
  expectLibraryError(
    () => resolvePublishInput("alice", { sourceItemId: 42 }),
    400,
    /sourceItemId must be an item id/,
  );
  expectLibraryError(
    () => resolvePublishInput("alice", { sourceItemId: "" }),
    400,
    /sourceItemId must be an item id/,
  );
  expectLibraryError(
    () => resolvePublishInput("alice", { sourceItemId: "tool-missing" }),
    404,
    /Source item not found/,
  );
});

test("publishing from a source item copies payload and names, never secret values", () => {
  const source = addInstalledItem("alice", {
    kind: "skill",
    name: "Source name",
    description: "Source description",
    license: "MIT",
    payload: skill("# Source", [{ key: "TOKEN", label: "Token" }]),
    secrets: { TOKEN: "source-only-secret-1234" },
  });

  const input = resolvePublishInput("alice", { sourceItemId: source.id });
  assert.equal(input.kind, "skill");
  assert.equal(input.name, "Source name");
  assert.equal(input.description, "Source description");
  assert.equal(input.license, "MIT");
  assert.deepEqual((input.payload as any).requiredFields, [{ key: "TOKEN", label: "Token" }]);
  // The sealed value is server-only and never part of the payload.
  assert.equal(JSON.stringify(input).includes("source-only-secret-1234"), false);
  assert.equal("sealedSecrets" in (input.payload as any), false);
});

test("publishing from a source item lets the body override metadata and changelog", () => {
  const source = addInstalledItem("alice", {
    kind: "skill",
    name: "Original",
    description: "Original description",
    license: "MIT",
    payload: skill("# Original"),
  });
  const input = resolvePublishInput("alice", {
    sourceItemId: source.id,
    name: "Renamed",
    description: "New description",
    license: "Apache-2.0",
    changelog: "renamed",
  });
  assert.equal(input.name, "Renamed");
  assert.equal(input.description, "New description");
  assert.equal(input.license, "Apache-2.0");
  assert.equal(input.changelog, "renamed");
});

test("forcedKind must match the source item's kind", () => {
  const source = addInstalledItem("alice", { kind: "skill", name: "S", payload: skill() });
  expectLibraryError(
    () => resolvePublishInput("alice", { sourceItemId: source.id }, "tool"),
    400,
    /same kind/,
  );
  const input = resolvePublishInput("alice", { sourceItemId: source.id }, "skill");
  assert.equal(input.kind, "skill");
});

test("a source item belonging to another account is not found", () => {
  const source = addInstalledItem("bob", { kind: "skill", name: "Bobs", payload: skill() });
  expectLibraryError(() => resolvePublishInput("alice", { sourceItemId: source.id }), 404, /not found/i);
});

test("inline publishing accepts a known kind and payload", () => {
  const input = resolvePublishInput("alice", {
    kind: "tool",
    name: "Inline tool",
    description: "inline",
    license: "MIT",
    payload: { kind: "tool", code: "return 1;" },
    changelog: "first",
  });
  assert.equal(input.kind, "tool");
  assert.equal(input.name, "Inline tool");
  assert.deepEqual(input.payload, { kind: "tool", code: "return 1;" });
  assert.equal(input.changelog, "first");
});

test("inline publishing rejects an unknown kind and a missing payload", () => {
  expectLibraryError(
    () => resolvePublishInput("alice", { kind: "nope", name: "x", payload: skill() }),
    400,
    /kind must be/,
  );
  expectLibraryError(
    () => resolvePublishInput("alice", { kind: "skill", name: "x" }),
    400,
    /payload is required/,
  );
});

test("forcedKind overrides an inline body kind", () => {
  const input = resolvePublishInput(
    "alice",
    { kind: "skill", name: "x", payload: { kind: "tool", code: "return 1;" } },
    "tool",
  );
  assert.equal(input.kind, "tool");
});

test("inline metadata defaults are empty strings", () => {
  const input = resolvePublishInput("alice", { kind: "skill", payload: skill() });
  assert.equal(input.name, "");
  assert.equal(input.description, "");
  assert.equal(input.license, "");
});
