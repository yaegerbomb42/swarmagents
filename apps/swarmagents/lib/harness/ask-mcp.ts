/**
 * ask_user plumbing.
 *
 * The agent asks the user a question through a small MCP stdio server seeded
 * into its VM. The server writes a pending-question file into the VM, blocks,
 * and polls for an answer file. The harness runner observes the same
 * `mcp__ask__ask_user` tool call in the claude stream, tells the runtime
 * manager (via the question gateway), and the manager writes the answer file
 * through the VM driver once the user answers. The agent then receives the
 * answer as the ordinary tool result, so the run resumes exactly where it was.
 *
 * File-based rendezvous (rather than a socket) keeps every byte inside the
 * VM: the host never executes an MCP server for a user, and the only host->VM
 * write is a normal VM-driver file write.
 */

/** Name of the MCP server exposing ask_user. */
export const ASK_MCP_SERVER_NAME = "ask";
/** Tool the ask server exposes. */
export const ASK_USER_TOOL = "ask_user";
/** Path inside the VM of the ask server script. */
export const ASK_MCP_SERVER_PATH = "/workspace/.swarm/ask-server.mjs";
/** Directory inside the VM where pending questions / answers rendezvous. */
export const ASK_QUESTIONS_DIR = "/workspace/.swarm/questions";

/** Default time the agent waits for an answer before giving up (30 min). */
export const ASK_QUESTION_TTL_MS = 30 * 60 * 1000;

export interface AskUserArguments {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

/** Is this tool call the ask_user MCP tool? */
export function isAskUserTool(toolName: string): boolean {
  return (
    toolName === `mcp__${ASK_MCP_SERVER_NAME}__${ASK_USER_TOOL}` ||
    toolName === ASK_USER_TOOL ||
    toolName.endsWith(`__${ASK_USER_TOOL}`)
  );
}

/** Parse and bound an ask_user tool input. Returns null without a question. */
export function parseAskUserArguments(input: unknown): AskUserArguments | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.trim().slice(0, 4000) : "";
  if (!question) return null;
  const options = Array.isArray(record.options)
    ? record.options
        .filter((option): option is string => typeof option === "string")
        .map((option) => option.trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const allowFreeText = record.allow_free_text !== false;
  return { question, options, allowFreeText };
}

/** VM paths for a question's pending and answer files. */
export function questionPaths(id: string): { pending: string; answer: string } {
  return {
    pending: `${ASK_QUESTIONS_DIR}/${id}.pending.json`,
    answer: `${ASK_QUESTIONS_DIR}/${id}.answer.json`,
  };
}

/**
 * MCP stdio server source, written into the VM as ASK_MCP_SERVER_PATH.
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */
export const ASK_MCP_SERVER_SOURCE = [
  "#!/usr/bin/env node",
  "// SwarmAgents ask_user MCP stdio server (auto-generated).",
  "// Writes a pending-question file and blocks until the harness writes an answer.",
  "import fs from \"node:fs\";",
  "import path from \"node:path\";",
  "import { randomUUID } from \"node:crypto\";",
  "",
  "const dir = process.env.SWARM_ASK_DIR || \"/workspace/.swarm/questions\";",
  "const ttlMs = Number(process.env.SWARM_ASK_TIMEOUT_MS) > 0 ? Number(process.env.SWARM_ASK_TIMEOUT_MS) : 1800000;",
  "",
  "const tools = [",
  "  {",
  "    name: \"ask_user\",",
  "    description: \"Ask the user a question and wait for their answer. Use this when you need a decision, missing detail, or confirmation that only the user can provide. The run pauses until they answer; the answer is returned as this tool's result.\",",
  "    inputSchema: {",
  "      type: \"object\",",
  "      properties: {",
  "        question: { type: \"string\", description: \"The question to show the user, in plain language.\" },",
  "        options: { type: \"array\", items: { type: \"string\" }, description: \"Optional short answers the user can click.\" },",
  "        allow_free_text: { type: \"boolean\", description: \"Whether the user may type an answer instead of choosing an option (default true).\" }",
  "      },",
  "      required: [\"question\"]",
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
  "async function callTool(name, args) {",
  "  if (name !== \"ask_user\") {",
  "    return toolResult({ error: \"unknown_tool\", message: \"Unknown tool: \" + name }, true);",
  "  }",
  "  const question = args && typeof args.question === \"string\" ? args.question.trim().slice(0, 4000) : \"\";",
  "  if (!question) return toolResult({ error: \"invalid_question\", message: \"question is required.\" }, true);",
  "  const options = Array.isArray(args.options)",
  "    ? args.options.filter((o) => typeof o === \"string\").map((o) => o.trim().slice(0, 200)).filter(Boolean).slice(0, 8)",
  "    : [];",
  "  const allowFreeText = !args || args.allow_free_text !== false;",
  "  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {}",
  "  const id = \"q_\" + randomUUID();",
  "  const pendingPath = path.join(dir, id + \".pending.json\");",
  "  const answerPath = path.join(dir, id + \".answer.json\");",
  "  const payload = { id, question, options, allowFreeText, createdAt: Date.now() };",
  "  try {",
  "    const tmp = pendingPath + \".tmp\";",
  "    fs.writeFileSync(tmp, JSON.stringify(payload));",
  "    fs.renameSync(tmp, pendingPath);",
  "  } catch (err) {",
  "    return toolResult({ error: \"ask_failed\", message: \"Could not record the question.\" }, true);",
  "  }",
  "  const deadline = Date.now() + ttlMs;",
  "  while (Date.now() < deadline) {",
  "    if (fs.existsSync(answerPath)) {",
  "      const answer = readAnswer(answerPath);",
  "      if (answer) {",
  "        cleanup(pendingPath, answerPath);",
  "        if (answer.status === \"answered\") {",
  "          return toolResult({ answer: typeof answer.answer === \"string\" ? answer.answer : String(answer.answer == null ? \"\" : answer.answer) }, false);",
  "        }",
  "        if (answer.status === \"cancelled\") {",
  "          return toolResult({ error: \"question_cancelled\", message: \"The user cancelled the run before answering.\" }, true);",
  "        }",
  "        return toolResult({ error: \"question_expired\", message: \"The question expired before the user answered.\" }, true);",
  "      }",
  "      // The answer file exists but is empty/partial: the harness may still be",
  "      // writing it. Keep polling instead of treating it as an expiry.",
  "    }",
  "    // Async sleep (not Atomics.wait): the event loop stays live while",
  "    // waiting, so the server still answers ping/initialize and observes",
  "    // notifications/cancel instead of blocking the whole stdio server.",
  "    await new Promise((resolve) => setTimeout(resolve, 100));",
  "  }",
  "  cleanup(pendingPath, answerPath);",
  "  return toolResult({ error: \"question_expired\", message: \"The user did not answer within \" + Math.round(ttlMs / 60000) + \" minutes.\" }, true);",
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
  "      serverInfo: { name: \"swarm-ask\", version: \"1.0.0\" }",
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
  "    reply(msg.id, await callTool(name, args));",
  "    return;",
  "  }",
  "  if (method === \"notifications/initialized\" || method === \"notifications/cancelled\") return;",
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
