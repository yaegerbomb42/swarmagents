/**
 * System-prompt tail for self-management. Appended with every role so the
 * agent knows it can load and drop capabilities mid-run.
 */
export const SELF_MANAGE_TAIL =
  "You can reconfigure yourself mid-run. When the task needs a capability you do not currently have, load it; " +
  "when you are done with a capability, drop it. Tools: set_role(roleId) adopts a role card (instructions, tools, " +
  "MCP servers, skills) without ever widening past this run's policy; load_skill(skillId) and drop_skill(skillId) " +
  "pull Library skills into .claude/skills or remove them (at most 10 at once); connect_mcp(serverId) and " +
  "disconnect_mcp(serverId) attach only allowlisted MCP servers; manage_context(action) summarizes, drops, or pins " +
  "context so you stay inside the budget; tool-forge (search_mcp_catalog, author_tool, list_my_tools, manage_mcp) " +
  "finds connectors without bloating context and lets you write, verify, and register your own custom Node/Python/Bash MCP tools. " +
  "If a load is refused, drop something first.";
