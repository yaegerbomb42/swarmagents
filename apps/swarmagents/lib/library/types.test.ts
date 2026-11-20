/**
 * Library payload types: kind guards, path safety, per-kind normalization and
 * the secret-material scanner. These are the invariants that keep a "skill"
 * from smuggling tool code and keep a payload from carrying a secret value.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  LIMITS,
  LibraryError,
  assertNoSecretMaterial,
  assertSafeRelativePath,
  clonePayload,
  isLibraryKind,
  normalizePayload,
  payloadSecretFields,
  type LibraryPayload,
} from "./types";

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

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "skill", skillMd: "# Skill", files: [], requiredFields: [], ...overrides };
}

function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "tool", language: "javascript", code: "return 1;", timeoutMs: 5000, ...overrides };
}

function mcp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "mcp", transport: "stdio", command: "server", args: [], ...overrides };
}

// ---- kind guards -----------------------------------------------------------

test("isLibraryKind accepts exactly the four kinds", () => {
  for (const kind of ["skill", "tool", "mcp", "connector"]) assert.equal(isLibraryKind(kind), true);
  for (const value of ["Skill", "server", "", null, 1, {}, []]) assert.equal(isLibraryKind(value), false);
});

test("clonePayload is a deep copy in both directions", () => {
  const original = {
    kind: "skill" as const,
    skillMd: "# A",
    files: [{ path: "a.txt", content: "x" }],
    requiredFields: [{ key: "TOKEN", label: "Token" }],
  };
  const copy = clonePayload(original);
  copy.skillMd = "# B";
  copy.files[0].content = "y";
  copy.requiredFields[0].key = "OTHER";
  assert.equal(original.skillMd, "# A");
  assert.equal(original.files[0].content, "x");
  assert.equal(original.requiredFields[0].key, "TOKEN");
});

test("payloadSecretFields returns only field names, never values", () => {
  const payload = normalizePayload("tool", tool({
    requiredFields: [{ key: "API_KEY", label: "API key", helpUrl: "https://example.test/keys" }],
  }));
  assert.deepEqual(payloadSecretFields(payload), [
    { key: "API_KEY", label: "API key", helpUrl: "https://example.test/keys" },
  ]);
});

// ---- relative paths --------------------------------------------------------

test("assertSafeRelativePath accepts nested relative paths and strips ./", () => {
  assert.equal(assertSafeRelativePath("scripts/check.sh"), "scripts/check.sh");
  assert.equal(assertSafeRelativePath("./scripts/check.sh"), "scripts/check.sh");
  assert.equal(assertSafeRelativePath("  a/b/c.txt  "), "a/b/c.txt");
});

test("assertSafeRelativePath rejects escapes and control characters", () => {
  for (const bad of ["", " ", "/etc/passwd", "C:/Windows", "a/../../b", "../x", "./", "a//b", "a/./b", "a\\b", "a\u0000b"]) {
    expectLibraryError(() => assertSafeRelativePath(bad), 400, /file path/);
  }
  expectLibraryError(() => assertSafeRelativePath("x".repeat(201)), 400, /1-200/);
  expectLibraryError(() => assertSafeRelativePath(12 as unknown as string));
});

// ---- skill payloads --------------------------------------------------------

test("normalizePayload(skill) fills defaults", () => {
  const payload = normalizePayload("skill", skill());
  assert.deepEqual(payload, { kind: "skill", skillMd: "# Skill", files: [], requiredFields: [] });
});

test("normalizePayload rejects a payload whose kind does not match the item", () => {
  expectLibraryError(() => normalizePayload("skill", tool()), 400, /kind must match/);
});

test("normalizePayload(skill) validates markdown, file paths and duplicates", () => {
  expectLibraryError(() => normalizePayload("skill", skill({ skillMd: "" })), 400, /skillMd is required/);
  expectLibraryError(() => normalizePayload("skill", skill({ skillMd: "x".repeat(LIMITS.skillMd + 1) })), 400, /at most/);
  expectLibraryError(() => normalizePayload("skill", skill({ files: "nope" })), 400, /files must be an array/);
  expectLibraryError(
    () => normalizePayload("skill", skill({ files: [{ path: "../x", content: "a" }] })),
    400,
    /files\[0\]\.path/,
  );
  expectLibraryError(
    () => normalizePayload("skill", skill({ files: [{ path: "a", content: "a" }, { path: "a", content: "b" }] })),
    400,
    /Duplicate file/,
  );
  expectLibraryError(
    () => normalizePayload("skill", skill({ files: [{ path: "a", content: "x".repeat(LIMITS.skillFile + 1) }] })),
    400,
    /too large/,
  );
  const tooMany = Array.from({ length: LIMITS.skillFiles + 1 }, (_, index) => ({
    path: `f${index}.txt`,
    content: "x",
  }));
  expectLibraryError(() => normalizePayload("skill", skill({ files: tooMany })), 400, /At most/);
});

// ---- tool payloads ---------------------------------------------------------

test("normalizePayload(tool) defaults language, timeout and input schema", () => {
  const payload = normalizePayload("tool", { kind: "tool", code: "return 1;" });
  assert.equal(payload.kind, "tool");
  assert.equal((payload as any).language, "javascript");
  assert.equal((payload as any).timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
  assert.deepEqual((payload as any).inputSchema, { type: "object", properties: {} });
});

test("normalizePayload(tool) validates language, code and the timeout range", () => {
  expectLibraryError(() => normalizePayload("tool", tool({ language: "python" })), 400, /javascript/);
  expectLibraryError(() => normalizePayload("tool", tool({ code: "  " })), 400, /code is required/);
  for (const timeoutMs of [999, 120_001, Number.NaN, "5000"]) {
    expectLibraryError(() => normalizePayload("tool", tool({ timeoutMs })), 400, /timeoutMs/);
  }
  const trimmed = normalizePayload("tool", tool({ timeoutMs: 5000.9 }));
  assert.equal((trimmed as any).timeoutMs, 5000);
});

test("normalizePayload(tool) deep-copies a custom input schema", () => {
  const schema = { type: "object", properties: { n: { type: "number" } } };
  const payload = normalizePayload("tool", tool({ inputSchema: schema }));
  assert.deepEqual((payload as any).inputSchema, schema);
  assert.notEqual((payload as any).inputSchema, schema);
  expectLibraryError(() => normalizePayload("tool", tool({ inputSchema: [] })), 400, /inputSchema/);
});

// ---- MCP / connector payloads ---------------------------------------------

test("normalizePayload(mcp) supports stdio commands and args", () => {
  const payload = normalizePayload("mcp", mcp({ args: ["--flag", "value"], tools: ["query"] }));
  assert.deepEqual(payload, {
    kind: "mcp",
    transport: "stdio",
    command: "server",
    args: ["--flag", "value"],
    requiredFields: [],
    tools: ["query"],
  });
  expectLibraryError(() => normalizePayload("mcp", mcp({ command: "" })), 400, /command is required/);
  expectLibraryError(() => normalizePayload("mcp", mcp({ args: Array.from({ length: LIMITS.args + 1 }, () => "x") })), 400, /args/);
  expectLibraryError(() => normalizePayload("mcp", mcp({ args: ["x".repeat(LIMITS.arg + 1)] })), 400, /args\[0\]/);
  expectLibraryError(() => normalizePayload("mcp", mcp({ tools: "query" })), 400, /tools/);
});

test("normalizePayload(connector) validates http endpoints", () => {
  const payload = normalizePayload("connector", {
    kind: "connector",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    requiredFields: [{ key: "TOKEN", label: "Token" }],
  });
  assert.equal(payload.kind, "connector");
  assert.equal((payload as any).url, "https://mcp.example.test/mcp");

  for (const url of ["not a url", "ftp://example.test/mcp", "https://user:pass@example.test/mcp"]) {
    expectLibraryError(() => normalizePayload("connector", { transport: "http", url }), 400, /url/);
  }
  expectLibraryError(
    () => normalizePayload("connector", { transport: "http", url: "https://example.test", command: "server" }),
    400,
    /cannot also set command/,
  );
  expectLibraryError(() => normalizePayload("mcp", { transport: "socket" }), 400, /transport/);
});

test("normalizePayload requires a transport on mcp/connector payloads", () => {
  expectLibraryError(() => normalizePayload("mcp", { kind: "mcp" }), 400, /transport/);
});

// ---- required secret fields ------------------------------------------------

test("required fields must be env-style, unique and at most 16", () => {
  expectLibraryError(() => normalizePayload("skill", skill({ requiredFields: "TOKEN" })), 400, /array/);
  expectLibraryError(
    () => normalizePayload("skill", skill({ requiredFields: [{ key: "1BAD" }] })),
    400,
    /env-style/,
  );
  expectLibraryError(
    () => normalizePayload("skill", skill({ requiredFields: [{ key: "A-B" }] })),
    400,
    /env-style/,
  );
  expectLibraryError(
    () => normalizePayload("skill", skill({ requiredFields: [{ key: "TOKEN" }, { key: "TOKEN" }] })),
    400,
    /Duplicate/,
  );
  const many = Array.from({ length: 17 }, (_, index) => ({ key: `KEY_${index}` }));
  expectLibraryError(() => normalizePayload("skill", skill({ requiredFields: many })), 400, /At most 16/);
});

test("required field labels default to the key and helpUrl must be http(s)", () => {
  const payload = normalizePayload("skill", skill({
    requiredFields: [
      { key: "A" },
      { key: "B", label: "Bee", helpUrl: "https://example.test/b" },
    ],
  }));
  assert.deepEqual((payload as any).requiredFields, [
    { key: "A", label: "A" },
    { key: "B", label: "Bee", helpUrl: "https://example.test/b" },
  ]);
  expectLibraryError(
    () => normalizePayload("skill", skill({ requiredFields: [{ key: "A", helpUrl: "ftp://example.test" }] })),
    400,
    /http\(s\)/,
  );
  expectLibraryError(
    () => normalizePayload("skill", skill({ requiredFields: [{ key: "A", helpUrl: "nope" }] })),
    400,
    /must be a URL/,
  );
});

// ---- secret-material scanner ----------------------------------------------

test("assertNoSecretMaterial rejects secret containers and secret-shaped keys", () => {
  for (const payload of [
    { secrets: { A: "x" } },
    { secretValues: { A: "x" } },
    { env: { A: "x" } },
    { headers: { Authorization: "x" } },
    { authorization: "Bearer x" },
    { token: "abc" },
    { password: "abc" },
    { api_key: "abc" },
    { "api-key": "abc" },
    { access_token: "abc" },
    { client_secret: "abc" },
    { nested: { token: "abc" } },
    [{ deep: [{ password: "abc" }] }],
  ]) {
    expectLibraryError(() => assertNoSecretMaterial(payload), 400, /secret material/);
  }
});

test("assertNoSecretMaterial allows field names and empty placeholders", () => {
  assert.doesNotThrow(() =>
    assertNoSecretMaterial({
      requiredFields: [{ key: "API_KEY", label: "API key" }],
      tokenName: "read-only",
      token: "",
      password: null,
      notes: "use your own value",
    }),
  );
});

// ---- error class -----------------------------------------------------------

test("LibraryError carries status and structured details", () => {
  const error = new LibraryError("Missing.", 409, { missingFields: ["TOKEN"] });
  assert.equal(error.name, "LibraryError");
  assert.equal(error.status, 409);
  assert.deepEqual(error.details, { missingFields: ["TOKEN"] });
  assert.equal(new LibraryError("Bad.").status, 400);
});

test("normalizePayload rejects non-object payloads", () => {
  for (const value of [null, undefined, "x", 1, []]) {
    expectLibraryError(() => normalizePayload("skill", value), 400, /payload must be an object/);
  }
});

test("skill payloads keep supporting files and byte-size limits", () => {
  const payload = normalizePayload("skill", skill({
    files: [{ path: "scripts/check.sh", content: "echo ok" }],
  })) as Extract<LibraryPayload, { kind: "skill" }>;
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].path, "scripts/check.sh");
});
