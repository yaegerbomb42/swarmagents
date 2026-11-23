import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_IDS,
  DEFAULT_ROLE_ID,
  DEFAULT_ROLE_MODELS,
  PERMISSIONS,
  PERMISSION_KEYS,
  ROLES_STORAGE_KEY,
  ROLE_CATEGORIES,
  ROLE_MCP_SERVER_REGISTRY,
  ROLE_SCHEMA,
  ROLE_SCHEMA_VERSION,
  ROLE_TOOLS,
  createRoleBundle,
  defaultAllowedRoleIds,
  buildRunRolePolicy,
  capabilityDeltaLabels,
  hasRoleEscalation,
  isRoleWithinRole,
  loadCustomRoles,
  mergeCustomRoles,
  normalizeCategory,
  normalizeMcpServers,
  normalizePermissions,
  normalizeRoleDefinition,
  normalizeSkills,
  normalizeTools,
  parseRoleBundle,
  parseRoleData,
  permissionLabels,
  resolveRoleSwitch,
  roleCapabilityDelta,
  roleCategoryLabel,
  roleModelLabel,
  saveCustomRoles,
  slugifyRoleId,
  toolLabel,
  uniqueRoleId,
} from "./roles.js";
import type { RoleDefinition, RolePermissions } from "./roles.js";

const NO_PERMISSIONS: RolePermissions = {
  readOnly: false,
  allowBash: false,
  allowWrite: false,
  allowNetwork: false,
  allowBrowser: false,
  allowSubagents: false,
};

function customRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id: "custom",
    name: "Custom",
    description: "A custom role.",
    glyph: "C",
    model: "",
    permissions: { ...NO_PERMISSIONS },
    tools: ["read_file"],
    mcpServers: [],
    skills: [],
    instructions: "Do the thing.",
    category: "core",
    builtin: false,
    ...overrides,
  };
}

/** A v1-era role bundle (custom roles saved before category/MCP/skills existed). */
function v1RoleBundle(roles: Array<Record<string, unknown>>): string {
  return JSON.stringify({ schema: ROLE_SCHEMA, version: 1, roles });
}

function memoryStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

// ---- Constants and static tables ----

test("role schema constants are stable", () => {
  assert.equal(ROLE_SCHEMA, "swarmagents.roles");
  assert.equal(ROLE_SCHEMA_VERSION, 2);
  assert.equal(ROLES_STORAGE_KEY, "swarmagents.roles.custom.v1");
  assert.equal(DEFAULT_ROLE_ID, "main");
});

test("ROLE_CATEGORIES covers exactly the categories roles can be", () => {
  const ids = ROLE_CATEGORIES.map((category) => category.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const role of BUILTIN_ROLES) assert.ok(ids.includes(role.category), `${role.id} has unknown category ${role.category}`);
  for (const category of ROLE_CATEGORIES) {
    assert.ok(category.label.length > 0);
    assert.ok(category.hint.length > 0);
    assert.equal(roleCategoryLabel(category.id), category.label);
  }
});

test("PERMISSIONS describes exactly the declared permission keys", () => {
  assert.deepEqual(
    PERMISSION_KEYS.map((key) => PERMISSIONS.find((meta) => meta.key === key)?.key),
    [...PERMISSION_KEYS]
  );
  assert.equal(new Set(PERMISSION_KEYS).size, PERMISSION_KEYS.length);
  for (const meta of PERMISSIONS) {
    assert.ok(meta.label.length > 0);
    assert.ok(meta.hint.length > 0);
  }
});

test("ROLE_TOOLS has unique names and toolLabel resolves known and unknown tools", () => {
  assert.equal(new Set(ROLE_TOOLS.map((tool) => tool.name)).size, ROLE_TOOLS.length);
  for (const tool of ROLE_TOOLS) {
    assert.equal(toolLabel(tool.name), tool.label);
  }
  assert.equal(toolLabel("mcp_custom_tool"), "mcp_custom_tool");
  assert.equal(toolLabel(""), "");
});

test("built-in roles are well formed and reference known tools", () => {
  const toolNames = new Set(ROLE_TOOLS.map((tool) => tool.name));
  const ids = BUILTIN_ROLES.map((role) => role.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const role of BUILTIN_ROLES) {
    assert.equal(role.builtin, true);
    assert.ok(role.name.length > 0);
    assert.ok(role.instructions.length > 0);
    assert.deepEqual(Object.keys(role.permissions).sort(), [...PERMISSION_KEYS].sort());
    for (const tool of role.tools) assert.ok(toolNames.has(tool), `${role.id} uses unknown tool ${tool}`);
    assert.ok(Array.isArray(role.mcpServers), `${role.id} mcpServers must be an array`);
    assert.ok(Array.isArray(role.skills), `${role.id} skills must be an array`);
    assert.ok(ROLE_CATEGORIES.some((category) => category.id === role.category), `${role.id} has an unknown category`);
  }
});

test("the role library has an A1 default and at least 12 distinct built-ins", () => {
  const main = BUILTIN_ROLES.find((role) => role.id === DEFAULT_ROLE_ID);
  assert.ok(main, "A1 role exists");
  assert.equal(main.builtin, true);
  assert.ok(main.tools.includes("bash"));
  assert.ok(main.tools.includes("subagent"));
  assert.ok(main.instructions.toLowerCase().includes("set_role"));
  assert.ok(BUILTIN_ROLES.length >= 13, `expected >= 13 built-ins, got ${BUILTIN_ROLES.length}`);
  const names = BUILTIN_ROLES.map((role) => role.name);
  for (const expected of ["A1", "Frontend Engineer", "Backend Engineer", "Debugger", "Code Reviewer", "Test Writer", "Security Auditor", "DevOps", "Deployer", "Researcher", "Data Analyst", "Technical Writer", "Browser Operator", "Product Designer"]) {
    assert.ok(names.includes(expected), `missing built-in role ${expected}`);
  }
});

test("BUILTIN_ROLE_IDS holds the built-in ids", () => {
  assert.equal(BUILTIN_ROLE_IDS.has("orchestrator"), true);
  assert.equal(BUILTIN_ROLE_IDS.has("researcher"), true);
  assert.equal(BUILTIN_ROLE_IDS.has("implementer"), true);
  assert.equal(BUILTIN_ROLE_IDS.has("auditor"), true);
  assert.equal(BUILTIN_ROLE_IDS.has("devops"), true);
  assert.equal(BUILTIN_ROLE_IDS.has("nope"), false);
  for (const role of BUILTIN_ROLES) assert.equal(BUILTIN_ROLE_IDS.has(role.id), true);
});

test("DEFAULT_ROLE_MODELS lists unique model ids", () => {
  assert.ok(DEFAULT_ROLE_MODELS.length > 0);
  assert.equal(new Set(DEFAULT_ROLE_MODELS.map((model) => model.id)).size, DEFAULT_ROLE_MODELS.length);
  for (const model of DEFAULT_ROLE_MODELS) assert.ok(model.label.length > 0);
});

// ---- slugifyRoleId / uniqueRoleId ----

test("slugifyRoleId lowercases and dashes a display name", () => {
  assert.equal(slugifyRoleId("My Custom Role"), "my-custom-role");
  assert.equal(slugifyRoleId("  Leading and trailing  "), "leading-and-trailing");
  assert.equal(slugifyRoleId("multiple___separators"), "multiple-separators");
  assert.equal(slugifyRoleId("under_score"), "under-score");
});

test("slugifyRoleId strips accents and non-ascii", () => {
  assert.equal(slugifyRoleId("Ünïcödé Rôle"), "unicode-role");
  assert.equal(slugifyRoleId("naïve café"), "naive-cafe");
});

test("slugifyRoleId falls back to 'role' when nothing usable is left", () => {
  assert.equal(slugifyRoleId(""), "role");
  assert.equal(slugifyRoleId("   "), "role");
  assert.equal(slugifyRoleId("🚀🎉"), "role");
  assert.equal(slugifyRoleId("---"), "role");
});

test("slugifyRoleId truncates to 48 characters without leaving a trailing dash", () => {
  const slug = slugifyRoleId(`${"a".repeat(47)}-bbbb`);
  assert.ok(slug.length <= 48);
  assert.equal(slug.endsWith("-"), false);
  assert.equal(slug, "a".repeat(47));
  assert.equal(slugifyRoleId("a".repeat(500)).length, 48);
});

test("uniqueRoleId keeps a free id and suffixes taken ones", () => {
  assert.equal(uniqueRoleId("my role", []), "my-role");
  assert.equal(uniqueRoleId("my role", ["other"]), "my-role");
  assert.equal(uniqueRoleId("my role", ["my-role"]), "my-role-2");
  assert.equal(uniqueRoleId("my role", ["my-role", "my-role-2"]), "my-role-3");
});

test("uniqueRoleId never returns a built-in id", () => {
  assert.equal(uniqueRoleId("researcher", []), "researcher-2");
  assert.equal(uniqueRoleId("orchestrator", ["orchestrator-2"]), "orchestrator-3");
  assert.equal(uniqueRoleId("devops", BUILTIN_ROLE_IDS), "devops-2");
});

// ---- normalizePermissions ----

test("normalizePermissions defaults everything to false", () => {
  assert.deepEqual(normalizePermissions(undefined), NO_PERMISSIONS);
  assert.deepEqual(normalizePermissions(null), NO_PERMISSIONS);
  assert.deepEqual(normalizePermissions("nope"), NO_PERMISSIONS);
  assert.deepEqual(normalizePermissions([1, 2]), NO_PERMISSIONS);
  assert.deepEqual(normalizePermissions({}), NO_PERMISSIONS);
});

test("normalizePermissions keeps booleans and ignores other types", () => {
  const perms = normalizePermissions({
    readOnly: false,
    allowBash: true,
    allowNetwork: "yes",
    allowBrowser: 1,
    allowSubagents: false,
  });
  assert.equal(perms.allowBash, true);
  assert.equal(perms.allowNetwork, false);
  assert.equal(perms.allowBrowser, false);
  assert.equal(perms.allowSubagents, false);
});

test("normalizePermissions makes read-only win over write", () => {
  const perms = normalizePermissions({ readOnly: true, allowWrite: true });
  assert.equal(perms.readOnly, true);
  assert.equal(perms.allowWrite, false);
});

test("normalizePermissions drops unknown keys", () => {
  const perms = normalizePermissions({ allowBash: true, allowTeleport: true });
  assert.deepEqual(Object.keys(perms).sort(), [...PERMISSION_KEYS].sort());
});

// ---- normalizeTools ----

test("normalizeTools returns an empty list for non-arrays", () => {
  assert.deepEqual(normalizeTools(undefined), []);
  assert.deepEqual(normalizeTools(null), []);
  assert.deepEqual(normalizeTools("read_file"), []);
  assert.deepEqual(normalizeTools({ 0: "read_file" }), []);
});

test("normalizeTools trims, drops junk and removes duplicates", () => {
  assert.deepEqual(normalizeTools(["read_file", " read_file ", "search"]), ["read_file", "search"]);
  assert.deepEqual(normalizeTools(["bad tool", "ok-tool", "with_underscore", "dot.name", "colon:name"]), [
    "ok-tool",
    "with_underscore",
    "dot.name",
    "colon:name",
  ]);
  assert.deepEqual(normalizeTools([42, null, undefined, {}, ""]), []);
});

test("normalizeTools caps the number of tools and the length of each name", () => {
  const many = Array.from({ length: 80 }, (_, i) => `tool_${i}`);
  assert.equal(normalizeTools(many).length, 64);
  const long = normalizeTools(["x".repeat(200)]);
  assert.equal(long[0].length, 80);
});

// ---- normalizeMcpServers / normalizeSkills / normalizeCategory ----

test("normalizeMcpServers and normalizeSkills return clean string lists", () => {
  assert.deepEqual(normalizeMcpServers(undefined), []);
  assert.deepEqual(normalizeMcpServers("postgres-mcp"), []);
  assert.deepEqual(normalizeMcpServers(["github-mcp", " github-mcp ", "postgres-mcp"]), ["github-mcp", "postgres-mcp"]);
  assert.deepEqual(normalizeMcpServers(["bad name", 42, ""]), []);
  assert.deepEqual(normalizeSkills(["terminal-exec", "file-editor", "terminal-exec"]), ["terminal-exec", "file-editor"]);
  assert.deepEqual(normalizeSkills(null), []);
});

test("normalizeCategory maps known ids and falls back to core", () => {
  assert.equal(normalizeCategory("build"), "build");
  assert.equal(normalizeCategory("quality"), "quality");
  assert.equal(normalizeCategory("ops"), "ops");
  assert.equal(normalizeCategory("research"), "research");
  assert.equal(normalizeCategory("core"), "core");
  assert.equal(normalizeCategory("nope"), "core");
  assert.equal(normalizeCategory(undefined), "core");
  assert.equal(normalizeCategory(null), "core");
});

test("normalizeRoleDefinition defaults v1 fields to v2 values", () => {
  const role = normalizeRoleDefinition({ name: "Legacy" });
  assert.ok(role);
  assert.deepEqual(role.mcpServers, []);
  assert.deepEqual(role.skills, []);
  assert.equal(role.category, "core");
});

test("normalizeRoleDefinition keeps valid MCP/skill ids and categories", () => {
  const role = normalizeRoleDefinition({
    name: "Modern",
    mcpServers: ["postgres-mcp", "postgres-mcp", "bad server", 7],
    skills: ["terminal-exec", "bad skill", 7, ""],
    category: "ops",
  });
  assert.ok(role);
  assert.deepEqual(role.mcpServers, ["postgres-mcp"]);
  assert.deepEqual(role.skills, ["terminal-exec"]);
  assert.equal(role.category, "ops");
});

test("v1 role bundles parse and migrate to v2 defaults", () => {
  const result = parseRoleBundle(v1RoleBundle([{ name: "Old Timer", id: "old-timer", tools: ["read_file"] }]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.roles.length, 1);
  const role = result.roles[0];
  assert.equal(role.id, "old-timer");
  assert.deepEqual(role.mcpServers, []);
  assert.deepEqual(role.skills, []);
  assert.equal(role.category, "core");
  assert.equal(role.builtin, false);
});

test("createRoleBundle writes v2 fields and copies arrays", () => {
  const role = customRole({ mcpServers: ["github-mcp"], skills: ["terminal-exec"], category: "build" });
  const bundle = createRoleBundle([role]);
  assert.equal(bundle.version, ROLE_SCHEMA_VERSION);
  assert.deepEqual(bundle.roles[0].mcpServers, ["github-mcp"]);
  assert.deepEqual(bundle.roles[0].skills, ["terminal-exec"]);
  assert.equal(bundle.roles[0].category, "build");
  assert.notEqual(bundle.roles[0].mcpServers, role.mcpServers);
  bundle.roles[0].mcpServers.push("postgres-mcp");
  assert.deepEqual(role.mcpServers, ["github-mcp"], "bundle must not alias the source arrays");
});

// ---- normalizeRoleDefinition ----

test("normalizeRoleDefinition rejects non-objects and nameless roles", () => {
  assert.equal(normalizeRoleDefinition(undefined), null);
  assert.equal(normalizeRoleDefinition(null), null);
  assert.equal(normalizeRoleDefinition("role"), null);
  assert.equal(normalizeRoleDefinition([]), null);
  assert.equal(normalizeRoleDefinition({}), null);
  assert.equal(normalizeRoleDefinition({ name: "   " }), null);
});

test("normalizeRoleDefinition accepts label as a name fallback", () => {
  const role = normalizeRoleDefinition({ label: "Label Role" });
  assert.ok(role);
  assert.equal(role.name, "Label Role");
  assert.equal(role.id, "label-role");
});

test("normalizeRoleDefinition fills defaults and forces builtin false", () => {
  const role = normalizeRoleDefinition({ name: "  Spaced Name  ", builtin: true });
  assert.ok(role);
  assert.equal(role.name, "Spaced Name");
  assert.equal(role.id, "spaced-name");
  assert.equal(role.description, "");
  assert.equal(role.glyph, "◇");
  assert.equal(role.model, "");
  assert.deepEqual(role.tools, []);
  assert.deepEqual(role.permissions, NO_PERMISSIONS);
  assert.equal(role.builtin, false);
});

test("normalizeRoleDefinition keeps a trimmed glyph of at most two characters", () => {
  assert.equal(normalizeRoleDefinition({ name: "A", glyph: "🚀🚀🚀" })?.glyph, "🚀🚀");
  assert.equal(normalizeRoleDefinition({ name: "A", glyph: "   " })?.glyph, "◇");
  assert.equal(normalizeRoleDefinition({ name: "A", glyph: 42 })?.glyph, "◇");
});

test("normalizeRoleDefinition truncates long fields", () => {
  const role = normalizeRoleDefinition({
    name: "N".repeat(200),
    description: "D".repeat(500),
    model: "M".repeat(500),
    instructions: "I".repeat(5000),
  });
  assert.ok(role);
  assert.equal(role.name.length, 60);
  assert.equal(role.description.length, 280);
  assert.equal(role.model.length, 200);
  assert.equal(role.instructions.length, 4000);
});

// ---- bundles ----

test("createRoleBundle drops built-ins and copies the payload", () => {
  const permissions = { ...NO_PERMISSIONS, allowBash: true };
  const tools = ["read_file"];
  const role = customRole({ permissions, tools });
  const bundle = createRoleBundle([...BUILTIN_ROLES, role]);

  assert.equal(bundle.schema, ROLE_SCHEMA);
  assert.equal(bundle.version, ROLE_SCHEMA_VERSION);
  assert.ok(!Number.isNaN(Date.parse(bundle.exportedAt)));
  assert.deepEqual(
    bundle.roles.map((r) => r.id),
    ["custom"]
  );
  assert.notEqual(bundle.roles[0].permissions, permissions);
  assert.notEqual(bundle.roles[0].tools, tools);
  assert.equal(bundle.roles[0].builtin, false);
  bundle.roles[0].permissions.allowBash = false;
  assert.equal(role.permissions.allowBash, true, "bundle must not alias the source permissions");
});

test("parseRoleBundle reports invalid JSON", () => {
  const result = parseRoleBundle("{ not json");
  assert.deepEqual(result.roles, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /valid JSON/);
});

test("parseRoleBundle reads a bundle and a bare array", () => {
  const bundle = createRoleBundle([customRole({ id: "alpha" })]);
  const fromBundle = parseRoleBundle(JSON.stringify(bundle));
  assert.deepEqual(fromBundle.errors, []);
  assert.deepEqual(fromBundle.roles.map((r) => r.id), ["alpha"]);

  const fromArray = parseRoleBundle(JSON.stringify([{ name: "Beta" }]));
  assert.deepEqual(fromArray.errors, []);
  assert.deepEqual(fromArray.roles.map((r) => r.id), ["beta"]);
});

test("parseRoleData rejects foreign, future and malformed bundles", () => {
  const foreign = parseRoleData({ schema: "other.schema", roles: [] });
  assert.deepEqual(foreign.roles, []);
  assert.match(foreign.errors[0], /isn't a SwarmAgents role bundle/);

  const future = parseRoleData({ schema: ROLE_SCHEMA, version: ROLE_SCHEMA_VERSION + 1, roles: [] });
  assert.deepEqual(future.roles, []);
  assert.match(future.errors[0], /newer version/);

  const noRoles = parseRoleData({ schema: ROLE_SCHEMA, version: ROLE_SCHEMA_VERSION });
  assert.deepEqual(noRoles.roles, []);
  assert.match(noRoles.errors[0], /no roles array/);

  const notABundle = parseRoleData("nope");
  assert.deepEqual(notABundle.roles, []);
  assert.match(notABundle.errors[0], /JSON array of roles/);
});

test("parseRoleData skips built-in ids and reports them", () => {
  const result = parseRoleData([{ name: "Fake Researcher", id: "researcher" }]);
  assert.deepEqual(result.roles, []);
  assert.match(result.errors[0], /built-in id "researcher"/);
});

test("parseRoleData keeps the later copy of a duplicated id", () => {
  const result = parseRoleData([
    { name: "First", id: "dup" },
    { name: "Second", id: "dup" },
  ]);
  assert.equal(result.roles.length, 1);
  assert.equal(result.roles[0].name, "Second");
  assert.match(result.errors[0], /repeats id "dup"/);
});

test("parseRoleData reports roles without a usable name", () => {
  const result = parseRoleData([{ id: "no-name" }, { name: "Fine", id: "fine" }]);
  assert.deepEqual(result.roles.map((r) => r.id), ["fine"]);
  assert.match(result.errors[0], /Role 1: needs a name/);
});

test("parseRoleData reads at most 100 roles", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ name: `Role ${i}`, id: `role-${i}` }));
  const result = parseRoleData(many);
  assert.equal(result.roles.length, 100);
  assert.match(result.errors[0], /first 100 roles/);
});

// ---- mergeCustomRoles ----

test("mergeCustomRoles replaces same-id roles and appends the rest", () => {
  const existing = [customRole({ id: "a", name: "Old A" }), customRole({ id: "b", name: "B" })];
  const incoming = [customRole({ id: "a", name: "New A" }), customRole({ id: "c", name: "C" })];
  const merged = mergeCustomRoles(existing, incoming);
  assert.deepEqual(
    merged.map((r) => r.id),
    ["a", "b", "c"]
  );
  assert.equal(merged[0].name, "New A");
});

test("mergeCustomRoles ignores built-in roles on both sides", () => {
  const merged = mergeCustomRoles(
    [...BUILTIN_ROLES, customRole({ id: "keep", name: "Keep" })],
    [customRole({ id: "researcher", name: "Fake" }), customRole({ id: "new", name: "New" })]
  );
  assert.deepEqual(
    merged.map((r) => r.id),
    ["keep", "new"]
  );
});

// ---- persistence ----

test("loadCustomRoles returns an empty list without a store", () => {
  assert.deepEqual(loadCustomRoles("key", null), []);
});

test("loadCustomRoles round-trips roles saved by saveCustomRoles", () => {
  const store = memoryStore();
  saveCustomRoles([customRole({ id: "alpha" }), ...BUILTIN_ROLES], "key", store);
  const loaded = loadCustomRoles("key", store);
  assert.deepEqual(
    loaded.map((r) => r.id),
    ["alpha"]
  );
  assert.equal(loaded[0].builtin, false);
});

test("loadCustomRoles ignores corrupt or empty storage", () => {
  assert.deepEqual(loadCustomRoles("key", memoryStore({ key: "" })), []);
  assert.deepEqual(loadCustomRoles("key", memoryStore({ key: "{broken" })), []);
  assert.deepEqual(loadCustomRoles("key", memoryStore({ key: "not json" })), []);
});

test("loadCustomRoles reads a bare array of roles", () => {
  const store = memoryStore({ key: JSON.stringify([{ name: "Solo", id: "solo" }]) });
  const loaded = loadCustomRoles("key", store);
  assert.deepEqual(
    loaded.map((r) => r.id),
    ["solo"]
  );
});

test("saveCustomRoles is a no-op without a store and survives a throwing store", () => {
  saveCustomRoles([customRole()], "key", null);
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  saveCustomRoles([customRole()], "key", throwing);
});

// ---- display helpers ----

test("permissionLabels lists the enabled permissions in a stable order", () => {
  assert.deepEqual(permissionLabels(NO_PERMISSIONS), []);
  assert.deepEqual(
    permissionLabels({
      readOnly: true,
      allowBash: true,
      allowWrite: true,
      allowNetwork: true,
      allowBrowser: true,
      allowSubagents: true,
    }),
    ["read-only", "shell", "write", "network", "browser", "sub-agents"]
  );
});

test("roleModelLabel falls back to the workspace default", () => {
  assert.equal(roleModelLabel(""), "Workspace default");
  assert.equal(roleModelLabel("   "), "Workspace default");
  assert.equal(roleModelLabel("  gpt-5  "), "gpt-5");
});

// ---- Role-switch validation (resolveRoleSwitch) ----

test("resolveRoleSwitch resolves an allowed role from the catalog", () => {
  const catalog = [...BUILTIN_ROLES, customRole({ id: "qa", name: "QA" })];
  const allowed = defaultAllowedRoleIds(catalog);
  const decision = resolveRoleSwitch(catalog, allowed, "main");
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.role.id, "main");
  const custom = resolveRoleSwitch(catalog, allowed, "qa");
  assert.equal(custom.ok, true);
});

test("resolveRoleSwitch rejects unknown role ids", () => {
  const catalog = BUILTIN_ROLES;
  const allowed = defaultAllowedRoleIds(catalog);
  const decision = resolveRoleSwitch(catalog, allowed, "no-such-role");
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.error, "unknown_role");
    assert.equal(decision.requestedId, "no-such-role");
  }
  assert.equal(resolveRoleSwitch(catalog, allowed, "").ok, false);
  assert.equal(resolveRoleSwitch(catalog, allowed, "   ").ok, false);
  // Whitespace around the requested id is normalized.
  assert.equal(resolveRoleSwitch(catalog, allowed, "  main  ").ok, true);
});

test("resolveRoleSwitch cannot escalate to a role outside the user's allowed set", () => {
  const catalog = [...BUILTIN_ROLES, customRole({ id: "locked", name: "Locked" })];
  // The user's policy only permits the main and researcher roles.
  const allowed = new Set(["main", "researcher"]);
  const blocked = resolveRoleSwitch(catalog, allowed, "locked");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error, "not_allowed");
  const blockedBuiltin = resolveRoleSwitch(catalog, allowed, "devops");
  assert.equal(blockedBuiltin.ok, false);
  if (!blockedBuiltin.ok) assert.equal(blockedBuiltin.error, "not_allowed");
  const ok = resolveRoleSwitch(catalog, allowed, "researcher");
  assert.equal(ok.ok, true);
});

// ---- Per-run role policy (capability escalation) ----

function builtinRole(id: string): RoleDefinition {
  const role = BUILTIN_ROLES.find((candidate) => candidate.id === id);
  assert.ok(role, `missing built-in role: ${id}`);
  return role as RoleDefinition;
}

test("roleCapabilityDelta detects a researcher -> deployer escalation", () => {
  const delta = roleCapabilityDelta(builtinRole("researcher"), builtinRole("deployer"));
  assert.equal(hasRoleEscalation(delta), true);
  assert.ok(delta.addedPermissions.includes("allowBash"));
  assert.ok(delta.addedPermissions.includes("allowWrite"));
  assert.ok(delta.addedPermissions.includes("readOnly"));
  assert.ok(delta.addedTools.includes("bash"));
  assert.ok(delta.addedTools.includes("write_file"));
  assert.ok(delta.addedMcpServers.includes("github-mcp"));
  const labels = capabilityDeltaLabels(delta);
  assert.ok(labels.includes("Shell"));
  assert.ok(labels.includes("Write files"));
  assert.ok(labels.some((label) => label.includes("GitHub")));
});

test("isRoleWithinRole is true only when nothing is added", () => {
  const researcher = builtinRole("researcher");
  const narrow = customRole({
    id: "facts-reader",
    permissions: { ...NO_PERMISSIONS, readOnly: true, allowNetwork: true },
    tools: ["read_file", "search"],
    mcpServers: [],
  });
  assert.equal(isRoleWithinRole(narrow, researcher), true);
  assert.equal(isRoleWithinRole(builtinRole("deployer"), researcher), false);
  // Capability is not symmetric: dropping tools/permissions is not a subset.
  assert.equal(isRoleWithinRole(researcher, narrow), false);
});

test("buildRunRolePolicy defaults to the starting role and its subsets", () => {
  const researcher = builtinRole("researcher");
  const policy = buildRunRolePolicy(BUILTIN_ROLES, researcher);
  assert.equal(policy.startingRole.id, "researcher");
  assert.ok(policy.allowedRoleIds.includes("researcher"));
  assert.equal(policy.allowedRoleIds.includes("deployer"), false);
  assert.equal(policy.allowedRoleIds.includes("main"), false);
  assert.deepEqual(policy.grantedRoleIds, []);
});

test("buildRunRolePolicy honours pre-grants but never exceeds the user's catalog", () => {
  const researcher = builtinRole("researcher");
  const policy = buildRunRolePolicy(BUILTIN_ROLES, researcher, [
    "deployer",
    "deployer",
    " no-such-role ",
    "researcher",
  ]);
  assert.ok(policy.allowedRoleIds.includes("deployer"));
  assert.equal(policy.allowedRoleIds.includes("no-such-role"), false);
  assert.deepEqual(policy.grantedRoleIds, ["deployer", "researcher"]);
  const catalogIds = new Set(BUILTIN_ROLES.map((role) => role.id));
  for (const id of policy.allowedRoleIds) assert.ok(catalogIds.has(id));
});

test("defaultAllowedRoleIds uses the supplied starting role as baseline", () => {
  const allowed = defaultAllowedRoleIds(BUILTIN_ROLES, builtinRole("researcher"));
  assert.ok(allowed.has("researcher"));
  assert.equal(allowed.has("deployer"), false);
  assert.equal(allowed.has("main"), false);
});

test("built-in Implementer (Coder) role pins the security lens", () => {
  const implementer = BUILTIN_ROLES.find((role) => role.id === "implementer");
  assert.ok(implementer, "implementer built-in exists");
  assert.equal(implementer.lens, "security");
});

test("normalizeRoleDefinition carries a valid lens through and drops an invalid one", () => {
  const withLens = normalizeRoleDefinition({ name: "x", lens: "security" });
  assert.equal(withLens?.lens, "security");
  const invalid = normalizeRoleDefinition({ name: "y", lens: "not-a-lens" });
  assert.equal(invalid?.lens, undefined);
  const generic = normalizeRoleDefinition({ name: "z" });
  assert.equal(generic?.lens, undefined);
});

test("the researcher built-in grants the web-search MCP server", () => {
  const researcher = builtinRole("researcher");
  assert.deepEqual(researcher.mcpServers, ["web-search"]);
  // The grant must reference a server the registry knows, or role-mcp
  // wiring silently has nothing to wire.
  assert.ok(
    ROLE_MCP_SERVER_REGISTRY["web-search"],
    "web-search must be registered in ROLE_MCP_SERVER_REGISTRY",
  );
});

test("web-search is granted to the researcher built-in only", () => {
  const granting = BUILTIN_ROLES.filter((role) => role.mcpServers.includes("web-search")).map(
    (role) => role.id,
  );
  assert.deepEqual(granting, ["researcher"]);
  // The default role's toolset is unchanged: no web-search MCP grant.
  assert.equal(builtinRole(DEFAULT_ROLE_ID).mcpServers.includes("web-search"), false);
});

test("every built-in role's MCP servers are registered servers", () => {
  for (const role of BUILTIN_ROLES) {
    for (const server of role.mcpServers) {
      assert.ok(
        ROLE_MCP_SERVER_REGISTRY[server],
        `${role.id} references unregistered MCP server ${server}`,
      );
    }
  }
});
