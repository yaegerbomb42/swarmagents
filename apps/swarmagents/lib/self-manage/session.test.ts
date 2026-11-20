import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_ROLES } from "../roles";
import { SelfManageSession } from "./session";

function role(id: string) {
  const found = BUILTIN_ROLES.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function session(startingId: string, granted: string[] = []) {
  const library = new Map<string, string>([
    ["terminal-exec", "# terminal"],
    ["file-editor", "# files"],
    ["browser-live", "# browser"],
  ]);
  return new SelfManageSession({
    catalog: BUILTIN_ROLES,
    startingRole: role(startingId),
    grantedRoleIds: granted,
    library,
    now: () => 1,
  });
}

test("set_role adopts a subset role and writes its library skills", () => {
  const run = session("main");
  const result = run.apply("set_role", { roleId: "researcher", reason: "needs sources" });
  assert.equal(result.ok, true);
  assert.match(result.injection, /Researcher/);
  assert.ok(result.fs.some((op) => op.op === "write" && op.path.includes("browser-live")));
  assert.equal(run.audit[0]?.why, "needs sources");
  assert.ok(run.allowlist.includes("Read"));
  assert.equal(run.allowlist.includes("Bash"), false);
});

test("set_role refuses a role that escalates past the run policy", () => {
  const run = session("researcher");
  const result = run.apply("mcp__roles__set_role", { role_id: "implementer" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /policy|escalat/);
  assert.equal(run.currentRole.id, "researcher");
});

test("load_skill only accepts the Library and honors the cap", () => {
  const run = session("researcher");
  const missing = run.apply("load_skill", { skillId: "not-a-skill" });
  assert.equal(missing.ok, false);
  const loaded = run.apply("load_skill", { skillId: "browser-live" });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fs[0]?.path, ".claude/skills/browser-live/SKILL.md");
  const tiny = new SelfManageSession({
    catalog: BUILTIN_ROLES,
    startingRole: role("researcher"),
    library: new Map([["browser-live", "a"], ["file-editor", "b"]]),
    skillCap: 1,
    now: () => 2,
  });
  assert.equal(tiny.apply("load_skill", { skillId: "browser-live" }).ok, true);
  const full = tiny.apply("load_skill", { skillId: "file-editor" });
  assert.equal(full.ok, false);
  assert.match(full.error ?? "", /drop something first/);
});

test("connect_mcp rejects servers outside the allowlist and the registry", () => {
  const run = session("researcher");
  assert.equal(run.apply("connect_mcp", { serverId: "https://evil.example" }).ok, false);
  assert.equal(run.apply("connect_mcp", { serverId: "github-mcp" }).ok, false);
  const main = session("main");
  const connected = main.apply("connect_mcp", { serverId: "github-mcp", why: "prs" });
  assert.equal(connected.ok, true);
  assert.equal(main.toolAllowed("mcp__github-mcp__create_pr"), true);
  assert.equal(main.apply("disconnect_mcp", { serverId: "github-mcp" }).ok, true);
  assert.equal(main.toolAllowed("mcp__github-mcp__create_pr"), false);
});

test("manage_context pins a skill so a role change keeps it", () => {
  const run = session("main");
  assert.equal(run.apply("load_skill", { skillId: "file-editor" }).ok, true);
  assert.equal(run.apply("manage_context", { action: "pin", target: "file-editor" }).ok, true);
  const switched = run.apply("set_role", { roleId: "researcher" });
  assert.equal(switched.ok, true);
  assert.equal(run.loadedSkills.has("file-editor"), true);
  assert.equal(run.apply("manage_context", { action: "summarize" }).ok, true);
  assert.equal(run.apply("drop_skill", { skillId: "file-editor" }).ok, true);
  assert.equal(run.loadedSkills.has("file-editor"), false);
});
