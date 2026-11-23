/**
 * ask_human_desktop plumbing.
 *
 * Shadow-to-takeover desktop handoff: when the agent hits a blocker in the
 * desktop VM (CAPTCHA, 2FA, SSO OAuth, a finicky UI drag) it calls
 * ask_human_desktop. A small MCP stdio server seeded into the VM writes a
 * pending-handoff file into the VM and blocks until the harness writes a
 * resolution file. The harness runner observes the same `mcp__desktop-handoff
 * __ask_human_desktop` tool call in the claude stream, tells the runtime
 * manager (via the handoff gateway), the UI pops an inline "Take the Wheel"
 * canvas, and once the user clicks "Hand Back to Agent" the manager writes the
 * resolution file — including a compact post-handoff state summary — through
 * the VM driver. The agent then receives the summary as the ordinary tool
 * result, so the run resumes exactly where it was.
 *
 * File-based rendezvous (rather than a socket) keeps every byte inside the
 * VM: the host never executes an MCP server for a user, and the only host->VM
 * write is a normal VM-driver file write.
 */

/** Name of the MCP server exposing ask_human_desktop. */
export const DESKTOP_HANDOFF_MCP_SERVER_NAME = "desktop-handoff";
/** Tool the desktop-handoff server exposes. */
export const DESKTOP_HANDOFF_TOOL = "ask_human_desktop";
/** Path inside the VM of the desktop-handoff server script. */
export const DESKTOP_HANDOFF_MCP_SERVER_PATH = "/workspace/.swarm/desktop-handoff-server.mjs";
/** Directory inside the VM where pending handoffs / resolutions rendezvous. */
export const DESKTOP_HANDOFF_DIR = "/workspace/.swarm/handoffs";

/** Default time the agent waits for a handoff before giving up (30 min). */
export const DESKTOP_HANDOFF_TTL_MS = 30 * 60 * 1000;

export interface DesktopHandoffArguments {
  reason: string;
  description: string;
}

/** Is this tool call the ask_human_desktop MCP tool? */
export function isDesktopHandoffTool(toolName: string): boolean {
  return (
    toolName === `mcp__${DESKTOP_HANDOFF_MCP_SERVER_NAME}__${DESKTOP_HANDOFF_TOOL}` ||
    toolName === DESKTOP_HANDOFF_TOOL ||
    toolName.endsWith(`__${DESKTOP_HANDOFF_TOOL}`)
  );
}

/** Parse and bound an ask_human_desktop tool input. Returns null without a reason. */
export function parseDesktopHandoffArguments(input: unknown): DesktopHandoffArguments | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 4000) : "";
  if (!reason) return null;
  const description = typeof record.description === "string" ? record.description.trim().slice(0, 4000) : "";
  return { reason, description };
}

/** VM paths for a handoff's pending and answer files. */
export function handoffPaths(id: string): { pending: string; answer: string } {
  return {
    pending: `${DESKTOP_HANDOFF_DIR}/${id}.pending.json`,
    answer: `${DESKTOP_HANDOFF_DIR}/${id}.answer.json`,
  };
}

/**
 * MCP stdio server source, written into the VM as DESKTOP_HANDOFF_MCP_SERVER_PATH.
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */
export const DESKTOP_HANDOFF_MCP_SERVER_SOURCE = [
  "#!/usr/bin/env node",
  "// SwarmAgents ask_human_desktop MCP stdio server (auto-generated).",
  "// Writes a pending-handoff file and waits until the harness writes a resolution.",
  "import fs from \"node:fs\";",
  "import path from \"node:path\";",
  "import { randomUUID } from \"node:crypto\";",
  "",
  "const dir = process.env.SWARM_DESKTOP_HANDOFF_DIR || \"/workspace/.swarm/handoffs\";",
  "const ttlMs = Number(process.env.SWARM_DESKTOP_HANDOFF_TIMEOUT_MS) > 0 ? Number(process.env.SWARM_DESKTOP_HANDOFF_TIMEOUT_MS) : 1800000;",
  "",
  "// In-flight tools/call requests, keyed by JSON-RPC request id. Each entry",
  "// tracks whether the client cancelled that request, so the poll loop can",
  "// abort the wait promptly instead of waiting out the TTL.",
  "const inFlightRequests = new Map();",
  "",
  "const tools = [",
  "  {",
  "    name: \"ask_human_desktop\",",
  "    description: \"Pause the run and hand the VM desktop over to the user to resolve a blocker you cannot (CAPTCHA, 2FA, SSO OAuth, a finicky UI drag). The UI opens a Take-the-Wheel canvas; the user solves it live and clicks Hand Back to Agent. The tool result then returns a short context summary of the post-handoff desktop state so you can continue where you left off. Credentials you enter never reach this model.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        reason: { type: \"string\", description: \"Why the desktop needs a human (a phrase, e.g. 'CAPTCHA present').\" },",
  "        description: { type: \"string\", description: \"Optional free-text detail on what to solve and what to do afterwards.\" }",
  "      },",
  "      required: [\"reason\"]",
  "    }",
  "  }",
  "];",
  "",
  "function toolResult(payload, isError) {",
  "  return { content: [{ type: \"text\", text: JSON.stringify(payload) }], isError: isError === true };",
  "}",
  "",
  "function readAnswer(answerPath) {",
  "  try {",
  "    return JSON.parse(fs.readFileSync(answerPath, \"utf8\"));",
  "  } catch (err) {",
  "    return null;",
  "  }",
  "}",
  "",
  "function cleanup(pendingPath, answerPath) {",
  "  for (const file of [pendingPath, answerPath]) {",
  "    try { fs.rmSync(file, { force: true }); } catch (err) {}",
  "  }",
  "}",
  "",
  "async function callTool(name, args, requestState) {",
  "  if (name !== \"ask_human_desktop\") {",
  "    return toolResult({ error: \"unknown_tool\", message: \"Unknown tool: \" + name }, true);",
  "  }",
  "  const reason = args && typeof args.reason === \"string\" ? args.reason.trim().slice(0, 4000) : \"\";",
  "  if (!reason) return toolResult({ error: \"invalid_reason\", message: \"reason is required.\" }, true);",
  "  const description = args && typeof args.description === \"string\" ? args.description.trim().slice(0, 4000) : \"\";",
  "  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {}",
  "  const id = \"h_\" + randomUUID();",
  "  const pendingPath = path.join(dir, id + \".pending.json\");",
  "  const answerPath = path.join(dir, id + \".answer.json\");",
  "  const payload = { id, reason, description, createdAt: Date.now() };",
  "  try {",
  "    const tmp = pendingPath + \".tmp\";",
  "    fs.writeFileSync(tmp, JSON.stringify(payload));",
  "    fs.renameSync(tmp, pendingPath);",
  "  } catch (err) {",
  "    return toolResult({ error: \"handoff_failed\", message: \"Could not record the handoff.\" }, true);",
  "  }",
  "  const deadline = Date.now() + ttlMs;",
  "  while (Date.now() < deadline) {",
  "    if (requestState && requestState.cancelled) {",
  "      cleanup(pendingPath, answerPath);",
  "      return toolResult({ error: \"handoff_cancelled\", message: \"The handoff request was cancelled before the user resolved the desktop.\" }, true);",
  "    }",
  "    if (fs.existsSync(answerPath)) {",
  "      const answer = readAnswer(answerPath);",
  "      if (answer) {",
  "        cleanup(pendingPath, answerPath);",
  "        if (answer.status === \"answered\") {",
  "          return toolResult({",
  "            ok: true,",
  "            summary: typeof answer.summary === \"string\" ? answer.summary : \"The user handed the desktop back to you.\"",
  "          }, false);",
  "        }",
  "        if (answer.status === \"cancelled\") {",
  "          return toolResult({ error: \"handoff_cancelled\", message: \"The user cancelled the run before resolving the desktop.\" }, true);",
  "        }",
  "        return toolResult({ error: \"handoff_expired\", message: \"The handoff expired before the user resolved the desktop.\" }, true);",
  "      }",
  "      // The answer file exists but is empty/partial: the harness may still be",
  "      // writing it. Keep polling instead of treating it as an expiry.",
  "    }",
  "    // Async sleep (not a blocking wait): the event loop stays live while",
  "    // waiting, so the server still answers ping/initialize and observes",
  "    // notifications/cancelled instead of blocking the whole stdio server.",
  "    await new Promise((resolve) => setTimeout(resolve, 100));",
  "  }",
  "  cleanup(pendingPath, answerPath);",
  "  return toolResult({ error: \"handoff_expired\", message: \"The user did not resolve the desktop within \" + Math.round(ttlMs / 60000) + \" minutes.\" }, true);",
  "}",
  "",
  "function reply(id, result) {",
  "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: id, result: result }) + \"\\n\");",
  "}",
  "",
  "function replyError(id, code, message) {",
  "  process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: id, error: { code: code, message: message } }) + \"\\n\");",
  "}",
  "",
  "async function handleMessage(msg) {",
  "  if (!msg || typeof msg !== \"object\") return;",
  "  const hasId = msg.id !== undefined && msg.id !== null;",
  "  const method = typeof msg.method === \"string\" ? msg.method : \"\";",
  "  if (method === \"initialize\") {",
  "    if (hasId) reply(msg.id, {",
  "      protocolVersion: (msg.params && msg.params.protocolVersion) || \"2024-11-05\",",
  "      capabilities: { tools: {} },",
  "      serverInfo: { name: \"swarm-desktop-handoff\", version: \"1.0.0\" }",
  "    });",
  "    return;",
  "  }",
  "  if (method === \"ping\") {",
  "    if (hasId) reply(msg.id, {});",
  "    return;",
  "  }",
  "  if (method === \"tools/list\") {",
  "    if (hasId) reply(msg.id, { tools: tools });",
  "    return;",
  "  }",
  "  if (method === \"tools/call\") {",
  "    if (!hasId) return;",
  "    const params = msg.params && typeof msg.params === \"object\" ? msg.params : {};",
  "    const name = typeof params.name === \"string\" ? params.name : \"\";",
  "    const args = params.arguments && typeof params.arguments === \"object\" ? params.arguments : {};",
  "    const requestState = { cancelled: false };",
  "    inFlightRequests.set(msg.id, requestState);",
  "    try {",
  "      reply(msg.id, await callTool(name, args, requestState));",
  "    } finally {",
  "      inFlightRequests.delete(msg.id);",
  "    }",
  "    return;",
  "  }",
  "  if (method === \"notifications/initialized\") return;",
  "  if (method === \"notifications/cancelled\") {",
  "    const params = msg.params && typeof msg.params === \"object\" ? msg.params : {};",
  "    const state = inFlightRequests.get(params.requestId);",
  "    if (state) state.cancelled = true;",
  "    return;",
  "  }",
  "  if (hasId) replyError(msg.id, -32601, \"Method not found: \" + method);",
  "}",
  "",
  "process.stdin.setEncoding(\"utf8\");",
  "let buffer = \"\";",
  "process.stdin.on(\"data\", (chunk) => {",
  "  buffer += chunk;",
  "  let newline;",
  "  while ((newline = buffer.indexOf(\"\\n\")) !== -1) {",
  "    const line = buffer.slice(0, newline).trim();",
  "    buffer = buffer.slice(newline + 1);",
  "    if (!line) continue;",
  "    let msg;",
  "    try { msg = JSON.parse(line); } catch (err) { continue; }",
  "    void handleMessage(msg);",
  "  }",
  "});",
  "",
  "process.stdin.on(\"end\", () => {});",
  "",
].join("\n");
