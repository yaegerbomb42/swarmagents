/**
 * The verified connector catalog: normalization and the conversion from a
 * catalog entry to an installable MCP payload. The catalog never carries a
 * secret value, only the field names the installer must fill.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CONNECTORS, connectorById, connectorPayload, type ConnectorEntry } from "./catalog";

test("connector catalog loads the shipped entries with stable ids", () => {
  assert.ok(CONNECTORS.length >= 30);
  const ids = new Set(CONNECTORS.map((entry) => entry.id));
  assert.equal(ids.size, CONNECTORS.length, "catalog ids are unique");
  for (const entry of CONNECTORS) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.transport === "stdio" || entry.transport === "http");
    assert.ok(["other", "data", "dev", "productivity", "communication"].includes(entry.category) || typeof entry.category === "string");
    assert.ok(Array.isArray(entry.requiredFields));
    assert.ok(Array.isArray(entry.tools));
  }
});

test("connectorById returns a known entry and null for an unknown one", () => {
  const github = connectorById("github");
  assert.ok(github);
  assert.equal(github!.id, "github");
  assert.equal(github!.transport, "http");
  assert.equal(connectorById("not-a-real-connector"), null);
});

test("connectorPayload turns an http entry into a connector payload with field names only", () => {
  const github = connectorById("github");
  assert.ok(github);
  const payload = connectorPayload(github!);
  assert.ok(payload);
  assert.equal(payload!.kind, "connector");
  assert.equal(payload!.transport, "http");
  assert.match((payload as any).url, /^https?:\/\//);
  // Field metadata, never a value.
  for (const field of payload!.requiredFields) {
    assert.deepEqual(Object.keys(field).sort(), ["key", "label"].concat(field.helpUrl ? ["helpUrl"] : []).sort());
    assert.equal(typeof field.key, "string");
  }
  assert.deepEqual(payload!.tools, github!.tools.length ? github!.tools : undefined);
});

test("connectorPayload turns a stdio entry into command + args", () => {
  const entry = CONNECTORS.find((candidate) => candidate.transport === "stdio" && candidate.install.trim());
  assert.ok(entry, "the catalog ships at least one stdio connector");
  const payload = connectorPayload(entry!);
  assert.ok(payload);
  assert.equal(payload!.transport, "stdio");
  const parts = entry!.install.trim().split(/\s+/);
  assert.equal((payload as any).command, parts[0]);
  assert.deepEqual((payload as any).args, parts.slice(1));
  assert.deepEqual(payload!.requiredFields, entry!.requiredFields.map((field) => ({
    key: field.key,
    label: field.label,
    ...(field.helpUrl ? { helpUrl: field.helpUrl } : {}),
  })));
});

test("connectorPayload refuses entries that cannot be installed", () => {
  const base: ConnectorEntry = {
    id: "synthetic",
    name: "Synthetic",
    category: "other",
    description: "",
    transport: "http",
    install: "npx -y something",
    requiredFields: [],
    auth: "",
    tools: [],
    verified: false,
  };
  assert.equal(connectorPayload(base), null, "an http entry needs an http(s) endpoint");
  assert.equal(connectorPayload({ ...base, transport: "stdio", install: "   " }), null);
  assert.equal(connectorPayload({ ...base, transport: "stdio", install: "node server.mjs" })!.transport, "stdio");
});

test("connectorPayload omits tools when the catalog lists none", () => {
  const entry: ConnectorEntry = {
    id: "synthetic-empty-tools",
    name: "Synthetic",
    category: "other",
    description: "",
    transport: "http",
    install: "https://example.test/mcp",
    requiredFields: [{ key: "TOKEN", label: "Token", secret: true }],
    auth: "token",
    tools: [],
    verified: true,
  };
  const payload = connectorPayload(entry);
  assert.ok(payload);
  assert.equal("tools" in payload!, false);
  assert.deepEqual(payload!.requiredFields, [{ key: "TOKEN", label: "Token" }]);
});
