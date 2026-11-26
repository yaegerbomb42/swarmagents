import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_IDS,
  DEFAULT_ROLE_ID,
  DESKTOP_ROLE_MCP_SERVERS,
  ROLE_MCP_SERVER_REGISTRY,
  ROLE_SKILL_REGISTRY,
  roleHasDesktopAccess,
} from "../roles.js";
import {
  A1_OPERATING_GUIDANCE,
  BROWSER_MCP_SERVER_NAME,
  COMPUTER_MCP_SERVER_PATH,
  MAX_ROLE_PHASES,
  ROLE_CATALOG_PATH,
  ROLE_LIST_ROLES_TOOL,
  ROLE_MCP_CONFIG_PATH,
  ROLE_MCP_SERVER_NAME,
  ROLE_MCP_SERVER_PATH,
  ROLE_SET_ROLE_TOOL,
  desktopMcpServerEntry,
  headlessBrowserMcpServerEntry,
  isRoleListTool,
  isRoleSwitchTool,
  roleAllowedTools,
  roleArgvFlags,
  roleCatalogJson,
  roleContinuationPrompt,
  roleMcpConfigJson,
  rolePhase,
  roleSeedFiles,
} from "./role-mcp.js";
import type { RoleDefinition } from "../roles.js";
import type { RolePhase } from "./types.js";

const mainRole = () => BUILTIN_ROLES.find((role) => role.id === DEFAULT_ROLE_ID)!;
const phaseFor = (roleId: string): RolePhase => rolePhase(BUILTIN_ROLES.find((role) => role.id === roleId)!);

test("roleAllowedTools maps tool ids to Claude Code permission strings", () => {
  const role = BUILTIN_ROLES.find((candidate) => candidate.id === "implementer")!;
  const tools = roleAllowedTools(role);
  assert.ok(tools.includes("Read"));
  assert.ok(tools.includes("Edit"));
  assert.ok(tools.includes("Write"));
  assert.ok(tools.includes("Bash"));
  assert.ok(tools.includes(`mcp__${ROLE_MCP_SERVER_NAME}__*`), "role-switch server is always granted");
  assert.ok(!tools.includes("Browser"), "implementer doesn't get the browser tool");
});

test("roleAllowedTools grants the role's MCP servers and passes unknown ids through", () => {
  const role = mainRole();
  const tools = roleAllowedTools(role);
  for (const server of role.mcpServers) {
    assert.ok(ROLE_MCP_SERVER_REGISTRY[server], `registry entry for ${server}`);
    assert.ok(tools.includes(`mcp__${server}__*`));
  }
  // Unknown/imported tool ids pass through as-is.
  const weird = roleAllowedTools({ ...role, tools: ["mcp_custom_tool", "plan"] });
  assert.ok(weird.includes("mcp_custom_tool"));
  assert.ok(weird.includes("Plan"));
});

test("roleArgvFlags builds --allowedTools/--mcp-config/--append-system-prompt per role", () => {
  const implementer = phaseFor("implementer");
  const flags = roleArgvFlags(implementer);
  assert.ok(flags.includes("--allowedTools"));
  const allowedIdx = flags.indexOf("--allowedTools");
  const tools = flags.slice(allowedIdx + 1, flags.indexOf("--mcp-config"));
  assert.ok(tools.includes("Read"));
  assert.ok(tools.includes("Edit"));
  assert.ok(tools.includes(`mcp__${ROLE_MCP_SERVER_NAME}__*`));
  assert.equal(flags[flags.indexOf("--mcp-config") + 1], ROLE_MCP_CONFIG_PATH);
  const promptIdx = flags.indexOf("--append-system-prompt");
  assert.ok(promptIdx !== -1);
  assert.equal(flags[promptIdx + 1], implementer.appendSystemPrompt);
  assert.ok(!flags.some((flag) => flag.trim() === ""), "no empty argv entries");
});

test("roleArgvFlags omits flags that have no value", () => {
  const noTools = { ...phaseFor("main"), allowedTools: [] };
  const noToolsFlags = roleArgvFlags(noTools);
  assert.ok(!noToolsFlags.includes("--allowedTools"));
  assert.equal(noToolsFlags[noToolsFlags.indexOf("--mcp-config") + 1], ROLE_MCP_CONFIG_PATH);

  const noConfig = { ...phaseFor("main"), mcpConfigPath: "" };
  const noConfigFlags = roleArgvFlags(noConfig);
  assert.ok(noConfigFlags.includes("--allowedTools"));
  assert.ok(!noConfigFlags.includes("--mcp-config"));

  const bare = { ...phaseFor("main"), allowedTools: [], mcpConfigPath: "" };
  assert.deepEqual(roleArgvFlags(bare), ["--append-system-prompt", bare.appendSystemPrompt!]);
});

test("roleCatalogJson keeps cloned built-in roles (id check, not reference equality)", () => {
  const cloned = BUILTIN_ROLES.map((role) => ({ ...role }));
  const parsed = JSON.parse(roleCatalogJson(cloned)) as { roles: Array<{ id: string }> };
  const ids = new Set(parsed.roles.map((role) => role.id));
  for (const role of BUILTIN_ROLES) assert.ok(ids.has(role.id), `cloned built-in ${role.id} survives the catalog filter`);
});

test("roleArgvFlags omits the system prompt when the role has none", () => {
  const noInstructions = { ...phaseFor("main"), appendSystemPrompt: undefined };
  const flags = roleArgvFlags(noInstructions);
  assert.ok(!flags.includes("--append-system-prompt"));
  assert.ok(flags.includes("--mcp-config"));
});

test("roleMcpConfigJson always wires the role-switch server with the allowed-role policy", () => {
  const phase = phaseFor("main");
  const config = JSON.parse(roleMcpConfigJson(phase, { allowedRoleIds: new Set(["main", "debugger"]) })) as {
    mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
  };
  const roles = config.mcpServers[ROLE_MCP_SERVER_NAME];
  assert.ok(roles, "roles server is present");
  assert.equal(roles.type, "stdio");
  assert.equal(roles.command, "node");
  assert.deepEqual(roles.args, [ROLE_MCP_SERVER_PATH]);
  assert.equal(roles.env.SWARM_ROLE_CATALOG, ROLE_CATALOG_PATH);
  assert.deepEqual(JSON.parse(roles.env.SWARM_ROLE_ALLOWED), ["main", "debugger"]);
});

test("roleCatalogJson lists built-ins with public shapes only", () => {
  const catalog = [...BUILTIN_ROLES];
  const parsed = JSON.parse(roleCatalogJson(catalog)) as { schema: string; roles: Array<{ id: string; permissions?: unknown }> };
  const ids = parsed.roles.map((role) => role.id);
  assert.ok(ids.includes(DEFAULT_ROLE_ID));
  assert.ok(ids.includes("frontend-engineer"));
  // No permissions (or other private fields) leak into the agent-visible catalog.
  for (const role of parsed.roles) assert.equal(role.permissions, undefined);
});

test("roleCatalogJson retains cloned built-in roles by id", () => {
  const catalog = BUILTIN_ROLES.map((role) => ({ ...role }));
  const parsed = JSON.parse(roleCatalogJson(catalog)) as { roles: Array<{ id: string }> };
  assert.deepEqual(parsed.roles.map((role) => role.id), [...BUILTIN_ROLE_IDS]);
});

test("roleSeedFiles writes the server script, catalog and mcp config", () => {
  const catalog = BUILTIN_ROLES;
  const files = roleSeedFiles(catalog, new Set(catalog.map((role) => role.id)));
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  assert.ok(byPath.has(ROLE_MCP_SERVER_PATH));
  assert.ok(byPath.has(ROLE_CATALOG_PATH));
  assert.ok(byPath.has(ROLE_MCP_CONFIG_PATH));
  const config = JSON.parse(byPath.get(ROLE_MCP_CONFIG_PATH)!) as { mcpServers: Record<string, unknown> };
  assert.ok(config.mcpServers[ROLE_MCP_SERVER_NAME]);
  const source = byPath.get(ROLE_MCP_SERVER_PATH)!;
  assert.match(source, /set_role/);
  assert.match(source, /list_roles/);
  assert.match(source, /JSON\.parse\(fs\.readFileSync/);
});

test("roleContinuationPrompt names both roles and the timing", () => {
  const from = BUILTIN_ROLES.find((role) => role.id === DEFAULT_ROLE_ID)!;
  const to = BUILTIN_ROLES.find((role) => role.id === "debugger")!;
  const prompt = roleContinuationPrompt(from, to);
  assert.match(prompt, /\bA1\b/);
  assert.match(prompt, /Debugger/);
  assert.match(prompt, /role switch/);
});

test("isRoleSwitchTool / isRoleListTool recognize the MCP tools", () => {
  assert.equal(isRoleSwitchTool(ROLE_SET_ROLE_TOOL), true);
  assert.equal(isRoleSwitchTool(`mcp__${ROLE_MCP_SERVER_NAME}__${ROLE_SET_ROLE_TOOL}`), true);
  assert.equal(isRoleSwitchTool(ROLE_LIST_ROLES_TOOL), false);
  assert.equal(isRoleListTool(ROLE_LIST_ROLES_TOOL), true);
  assert.equal(isRoleListTool(`mcp__${ROLE_MCP_SERVER_NAME}__${ROLE_LIST_ROLES_TOOL}`), true);
  assert.equal(isRoleListTool(ROLE_SET_ROLE_TOOL), false);
  assert.equal(isRoleSwitchTool("Bash"), false);
  assert.equal(isRoleListTool("Read"), false);
});

test("MAX_ROLE_PHASES caps runaway switch loops", () => {
  assert.ok(MAX_ROLE_PHASES >= 2 && MAX_ROLE_PHASES <= 32);
});

test("every built-in role's MCP/skill references resolve in the registries", () => {
  for (const role of BUILTIN_ROLES) {
    for (const server of role.mcpServers) {
      assert.ok(ROLE_MCP_SERVER_REGISTRY[server], `${role.id} references unknown MCP server ${server}`);
    }
    for (const skill of role.skills) {
      assert.ok(ROLE_SKILL_REGISTRY[skill], `${role.id} references unknown skill ${skill}`);
    }
  }
});

test("headless browser roles get a real isolated Playwright MCP server", () => {
  const main = mainRole();
  const tools = roleAllowedTools(main);
  assert.ok(tools.includes(`mcp__${BROWSER_MCP_SERVER_NAME}__*`));

  const phase = rolePhase(main);
  const config = JSON.parse(roleMcpConfigJson(phase, {
    allowedRoleIds: new Set([main.id]),
    roleDef: main,
    desktopMode: false,
  })) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const browser = config.mcpServers[BROWSER_MCP_SERVER_NAME];
  assert.ok(browser);
  assert.deepEqual(browser, headlessBrowserMcpServerEntry());
  assert.equal(browser.command, "node");
  assert.ok(browser.args.includes("--headless"));
  assert.ok(browser.args.includes("--isolated"));
  assert.ok(browser.args.includes("/usr/bin/chromium"));
  // Headless runs stay on an ephemeral profile: no persistent user-data-dir,
  // so one run's logins never leak into another run.
  assert.ok(!browser.args.includes("--user-data-dir"));
  assert.equal(browser.args[0], "/workspace/.swarm/playwright-mcp-launcher.cjs");

  const implementer = BUILTIN_ROLES.find((role) => role.id === "implementer")!;
  const implementerPhase = rolePhase(implementer);
  const implementerConfig = JSON.parse(roleMcpConfigJson(implementerPhase, {
    allowedRoleIds: new Set([implementer.id]),
    roleDef: implementer,
    desktopMode: false,
  })) as { mcpServers: Record<string, unknown> };
  assert.equal(implementerConfig.mcpServers[BROWSER_MCP_SERVER_NAME], undefined);
});

// ---- Desktop mode role wiring (computer-mcp / playwright-mcp) ---------------

test("desktopMcpServerEntry produces concrete stdio entries for the desktop servers", () => {
  const computer = desktopMcpServerEntry("computer-mcp");
  assert.deepEqual(computer, {
    type: "stdio",
    command: "node",
    args: [COMPUTER_MCP_SERVER_PATH],
    env: { DISPLAY: ":1" },
  });
  const playwright = desktopMcpServerEntry("playwright-mcp");
  assert.equal(playwright?.type, "stdio");
  assert.equal(playwright?.command, "node");
  assert.deepEqual((playwright as { args: string[] }).args, [
    "/workspace/.swarm/playwright-mcp-launcher.cjs",
    "--browser", "chromium",
    "--executable-path", "/usr/bin/chromium",
    "--user-data-dir", "/workspace/.swarm/browser-profile",
    "--no-sandbox",
    "--init-page", "/workspace/.swarm/playwright-policy.cjs",
  ]);
  assert.deepEqual((playwright as { env: Record<string, string> }).env, { DISPLAY: ":1" });
  // Unknown ids never produce an entry — a role can only wire what we ship.
  assert.equal(desktopMcpServerEntry("roles"), null);
  assert.equal(desktopMcpServerEntry("nope"), null);
});

test("roleHasDesktopAccess: browser-access built-ins get desktop, others don't", () => {
  for (const role of BUILTIN_ROLES) {
    assert.equal(
      roleHasDesktopAccess(role),
      role.permissions.allowBrowser,
      `${role.id}: desktop access should mirror allowBrowser`,
    );
  }
});

test("roleHasDesktopAccess: custom roles must opt in explicitly", () => {
  const implementer = BUILTIN_ROLES.find((role) => role.id === "implementer")!;
  const base = {
    ...implementer,
    id: "custom-researcher",
    name: "Custom Researcher",
    builtin: false,
    permissions: {
      readOnly: false,
      allowBash: false,
      allowWrite: true,
      allowNetwork: true,
      allowBrowser: true,
      allowSubagents: false,
    },
    tools: ["Read", "Edit"],
    mcpServers: [],
    skills: [],
  } satisfies RoleDefinition;
  assert.equal(roleHasDesktopAccess({ ...base, mcpServers: ["postgres-mcp"] }), false);
  assert.equal(roleHasDesktopAccess({ ...base, mcpServers: ["computer-mcp"] }), true);
  assert.equal(roleHasDesktopAccess({ ...base, mcpServers: ["playwright-mcp"] }), true);
  // No browser permission -> desktop access is impossible even when opted in.
  const noBrowser = { ...base, permissions: { ...base.permissions, allowBrowser: false }, mcpServers: ["computer-mcp"] };
  assert.equal(roleHasDesktopAccess(noBrowser), false);
});

test("roleAllowedTools grants desktop MCP servers only in desktop mode for desktop roles", () => {
  const main = mainRole();
  assert.ok(!roleAllowedTools(main).some((t) => t.startsWith("mcp__computer-mcp")));
  assert.ok(!roleAllowedTools(main).some((t) => t.startsWith("mcp__playwright-mcp")));
  const desktopTools = roleAllowedTools(main, { desktopMode: true });
  for (const server of DESKTOP_ROLE_MCP_SERVERS) {
    assert.ok(desktopTools.includes(`mcp__${server}__*`), `main gets ${server} in desktop mode`);
  }
  const implementer = BUILTIN_ROLES.find((role) => role.id === "implementer")!;
  const implementerTools = roleAllowedTools(implementer, { desktopMode: true });
  assert.ok(!implementerTools.some((t) => t.startsWith("mcp__computer-mcp")), "implementer has no desktop (");
  assert.ok(!implementerTools.some((t) => t.startsWith("mcp__playwright-mcp")));
});

test("roleAllowedTools and roleMcpConfigJson always wire the desktop-handoff server", () => {
  const main = mainRole();
  // ask_human_desktop is granted like ask_user: to every tool-using agent,
  // independent of desktop mode (it only pauses the run for a human).
  assert.ok(roleAllowedTools(main).includes("mcp__desktop-handoff__*"));
  assert.ok(roleAllowedTools(main, { desktopMode: true }).includes("mcp__desktop-handoff__*"));

  const phase = rolePhase(main);
  const config = JSON.parse(roleMcpConfigJson(phase, { allowedRoleIds: new Set([main.id]), roleDef: main })) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(config.mcpServers["desktop-handoff"], "desktop-handoff server is wired");
  const entry = config.mcpServers["desktop-handoff"] as { env?: Record<string, unknown> };
  assert.equal(entry.env?.SWARM_DESKTOP_HANDOFF_DIR, "/workspace/.swarm/handoffs");
});

test("roleMcpConfigJson wires the desktop servers only for desktop roles in desktop mode", () => {
  const withDesktop = (role: RoleDefinition, desktopMode: boolean) => {
    const phase = rolePhase(role, { desktopMode });
    return JSON.parse(roleMcpConfigJson(phase, { allowedRoleIds: new Set([role.id]), roleDef: role, desktopMode })) as {
      mcpServers: Record<string, unknown>;
    };
  };

  const mainDesktop = withDesktop(mainRole(), true);
  assert.ok(mainDesktop.mcpServers["computer-mcp"], "main gets computer-mcp in desktop mode");
  assert.ok(mainDesktop.mcpServers["playwright-mcp"], "main gets playwright-mcp in desktop mode");

  // Desktop mode off -> exactly today's surface (roles server only, here).
  const mainLegacy = withDesktop(mainRole(), false);
  assert.equal(mainLegacy.mcpServers["computer-mcp"], undefined);
  assert.equal(mainLegacy.mcpServers["playwright-mcp"], undefined);

  // Non-desktop role never gets them, even in desktop mode.
  const implementer = BUILTIN_ROLES.find((role) => role.id === "implementer")!;
  const implementerDesktop = withDesktop(implementer, true);
  assert.equal(implementerDesktop.mcpServers["computer-mcp"], undefined);
  assert.equal(implementerDesktop.mcpServers["playwright-mcp"], undefined);

  // Custom role without desktop opt-in never gets them.
  const custom = {
    ...mainRole(),
    id: "custom",
    name: "Custom",
    builtin: false,
    tools: ["Read"],
    mcpServers: ["postgres-mcp"],
    skills: [],
  } satisfies RoleDefinition;
  const customDesktop = withDesktop(custom, true);
  assert.equal(customDesktop.mcpServers["computer-mcp"], undefined);
  assert.equal(customDesktop.mcpServers["playwright-mcp"], undefined);
  // Custom role that opts in gets the full desktop surface (both servers).
  const optedIn = withDesktop({ ...custom, mcpServers: ["computer-mcp"] }, true);
  assert.ok(optedIn.mcpServers["computer-mcp"]);
  assert.ok(optedIn.mcpServers["playwright-mcp"]);
});

test("roleSeedFiles honors desktop mode when seeding the initial config", () => {
  const catalog = BUILTIN_ROLES;
  const files = roleSeedFiles(catalog, new Set(catalog.map((role) => role.id)), undefined, { desktopMode: true });
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const config = JSON.parse(byPath.get(ROLE_MCP_CONFIG_PATH)!) as { mcpServers: Record<string, unknown> };
  // The catalog's first role is the Main Agent, which has browser access.
  assert.ok(config.mcpServers["computer-mcp"], "seeded config includes computer-mcp in desktop mode");
  assert.ok(config.mcpServers["playwright-mcp"]);
});

test("rolePhase appends the long-running-work tail to every role's system prompt", () => {
  for (const role of BUILTIN_ROLES) {
    const phase = rolePhase(role);
    assert.ok(phase.appendSystemPrompt, `${role.id} should have a system prompt`);
    assert.ok(
      phase.appendSystemPrompt!.includes("Long-running work stays visible"),
      `${role.id} is missing the foreground-work tail`,
    );
    assert.ok(
      phase.appendSystemPrompt!.includes(role.instructions),
      `${role.id} should keep its own instructions ahead of the tail`,
    );
  }
});

test("rolePhase appends the tail even to a role without instructions", () => {
  const bare: RoleDefinition = {
    ...BUILTIN_ROLES.find((role) => role.id === "main")!,
    instructions: "",
  };
  const phase = rolePhase(bare);
  assert.ok(phase.appendSystemPrompt?.includes("Long-running work stays visible"));
});

test("A1's prompt states its identity, desktop tool choice and deliverable check", () => {
  const prompt = rolePhase(mainRole()).appendSystemPrompt ?? "";
  assert.match(prompt, /You are A1/);
  assert.match(prompt, /Identify yourself as A1/);
  // Shell vs visible browser vs desktop apps.
  assert.match(prompt, /Bash and the file tools/);
  assert.match(prompt, /playwright-mcp/);
  assert.match(prompt, /computer-mcp/);
  // describe_screen is the cheap default; screenshot is for pixels only.
  assert.match(prompt, /describe_screen first/);
  assert.match(prompt, /take a screenshot only when/i);
  // Self-verification before finishing.
  assert.match(prompt, /Before you finish, verify the deliverable/i);
  assert.match(prompt, /Never claim verification you did not perform/);
});

test("A1 operating guidance is not appended to specialist roles", () => {
  const implementer = BUILTIN_ROLES.find((role) => role.id === "implementer")!;
  const prompt = rolePhase(implementer).appendSystemPrompt ?? "";
  assert.ok(!prompt.includes(A1_OPERATING_GUIDANCE));
  assert.doesNotMatch(prompt, /describe_screen first/);
  // The shared tails still ride with every role.
  assert.match(prompt, /Long-running work stays visible/);
});

// ---- Capability-aware run modes (text / chat) ------------------------------

const desktopRole = (overrides: Partial<RoleDefinition> = {}): RoleDefinition => ({
  id: "desktop-helper",
  name: "Desktop helper",
  description: "Uses the visible desktop.",
  glyph: "D",
  model: "",
  permissions: {
    readOnly: false,
    allowBash: true,
    allowWrite: true,
    allowNetwork: true,
    allowBrowser: true,
    allowSubagents: false,
  },
  tools: ["bash", "browser", "web_fetch"],
  mcpServers: ["computer-mcp", "playwright-mcp"],
  skills: [],
  instructions: "Do the work.",
  category: "core",
  builtin: false,
  ...overrides,
});

test("non-gui runs never grant desktop MCP tools even if a role lists them", () => {
  const tools = roleAllowedTools(desktopRole(), { desktopMode: false });
  assert.ok(!tools.some((t) => t.startsWith("mcp__computer-mcp")));
  assert.ok(!tools.some((t) => t.startsWith("mcp__playwright-mcp")));
  assert.ok(tools.includes(`mcp__${BROWSER_MCP_SERVER_NAME}__*`), "headless browser remains available");
  assert.ok(tools.includes("Bash"), "sandbox tools stay available in text mode");
  assert.ok(tools.includes("Browser"));

  const phase = rolePhase(desktopRole(), { desktopMode: false });
  assert.equal(phase.toolsDisabled, undefined);
  assert.ok(!phase.allowedTools.some((t) => t.startsWith("mcp__computer-mcp")));
});

test("chat mode (model cannot call tools) disables every tool and the MCP config", () => {
  assert.deepEqual(roleAllowedTools(desktopRole(), { desktopMode: true, tools: false }), []);

  const phase = rolePhase(desktopRole(), { desktopMode: true, tools: false });
  assert.equal(phase.toolsDisabled, true);
  assert.deepEqual(phase.allowedTools, []);
  assert.equal(phase.mcpConfigPath, "");
  const flags = roleArgvFlags(phase);
  assert.deepEqual(flags.slice(0, 2), ["--tools", ""], "tools explicitly disabled");
  assert.ok(!flags.includes("--allowedTools"), "no empty --allowedTools flag");
  assert.ok(!flags.includes("--mcp-config"), "no empty --mcp-config flag");
  assert.ok(!flags.join(" ").includes("mcp__"));
});
