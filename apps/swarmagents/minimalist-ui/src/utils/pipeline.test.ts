import { test } from "node:test";
import assert from "node:assert/strict";
import { removeRole, moveRole, reorderRole, addRole } from "./pipeline";
import { MAX_ROLES } from "../data";

function makeRole(id: string, uid: string) {
  return {
    id,
    uid,
    name: uid,
    icon: "Bot",
    blurb: "",
    prompt: "",
    hue: 0,
    tools: [],
    mcpSkills: [],
    providerUid: "sim",
  };
}

// ---- removeRole ----

test("removeRole drops the role with the given uid", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = removeRole(roles, "2");
  assert.deepEqual(out.map((r) => r.uid), ["1", "3"]);
});

test("removeRole is a no-op when uid is not found", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2")];
  const out = removeRole(roles, "99");
  assert.deepEqual(out.map((r) => r.uid), ["1", "2"]);
});

// ---- moveRole ----

test("moveRole moves a role to a later position", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = moveRole(roles, "1", 2);
  assert.deepEqual(out.map((r) => r.uid), ["2", "1", "3"]);
});

test("moveRole moves a role to an earlier position", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = moveRole(roles, "3", 0);
  assert.deepEqual(out.map((r) => r.uid), ["3", "1", "2"]);
});

test("moveRole is a no-op for unknown uid", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2")];
  const out = moveRole(roles, "99", 1);
  assert.deepEqual(out.map((r) => r.uid), ["1", "2"]);
});

// ---- reorderRole ----

test("reorderRole swaps adjacent items forward", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = reorderRole(roles, 0, 1);
  assert.deepEqual(out.map((r) => r.uid), ["2", "1", "3"]);
});

test("reorderRole swaps adjacent items backward", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = reorderRole(roles, 2, 1);
  assert.deepEqual(out.map((r) => r.uid), ["1", "3", "2"]);
});

test("reorderRole is a no-op for out-of-range indices", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2")];
  assert.deepEqual(reorderRole(roles, -1, 0).map((r) => r.uid), ["1", "2"]);
  assert.deepEqual(reorderRole(roles, 0, 5).map((r) => r.uid), ["1", "2"]);
});

test("reorderRole can move last to first", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = reorderRole(roles, 2, 0);
  assert.deepEqual(out.map((r) => r.uid), ["3", "1", "2"]);
});

test("reorderRole can move first to last", () => {
  const roles = [makeRole("a", "1"), makeRole("b", "2"), makeRole("c", "3")];
  const out = reorderRole(roles, 0, 2);
  assert.deepEqual(out.map((r) => r.uid), ["2", "3", "1"]);
});

// ---- addRole ----

function makePreset(id: string): { id: string; name: string; icon: string; blurb: string; prompt: string; hue: number; tools: string[]; mcpSkills: string[] } {
  return { id, name: id, icon: "Bot", blurb: "", prompt: "", hue: 0, tools: [], mcpSkills: [] };
}

test("addRole appends a role and returns added=true", () => {
  const preset = makePreset("new");
  const { roles, added } = addRole([], preset, "sim");
  assert.equal(added, true);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].id, "new");
  assert.equal(roles[0].providerUid, "sim");
});

test("addRole generates a unique uid", () => {
  const preset = makePreset("x");
  const a = addRole([], preset, "sim");
  const b = addRole(a.roles, preset, "sim");
  assert.notEqual(a.roles[0].uid, b.roles[1].uid);
});

test("addRole refuses when pipeline is at capacity", () => {
  const full = Array.from({ length: MAX_ROLES }, (_, i) => makeRole("f", String(i)));
  const preset = makePreset("overflow");
  const { roles, added } = addRole(full, preset, "sim");
  assert.equal(added, false);
  assert.equal(roles.length, MAX_ROLES);
});
