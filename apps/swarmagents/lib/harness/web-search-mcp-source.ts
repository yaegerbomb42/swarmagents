/**
 * The web-search MCP server (VM side).
 *
 * The server is written into the user's VM next to the role-switch server
 * and exposed to the agent as the `web-search` MCP server. It exposes one
 * tool:
 *
 *   - web_search(query, limit?) — search the web via the host.
 *
 * The search itself runs on the server (lib/web/search.ts) with the run
 * owner's own backend/key: this VM-side process only holds the per-run
 * token and POSTs to /api/runtime/web/<runToken>/search. The search API key
 * never enters the VM.
 *
 * Host discovery, in order:
 *   1. SWARM_WEB_SEARCH_URL — full search URL (token included), when the
 *      harness wires it explicitly via the MCP config env.
 *   2. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN — the LLM-proxy env the
 *      runner already sets for every proxied run; the base URL embeds the
 *      same run token this endpoint authenticates with.
 *   3. SWARM_APPROVAL_URL origin + SWARM_APPROVAL_TOKEN — the approval-hook
 *      env, minted from the same run token.
 * With none of these (e.g. a non-proxied local run), the tool returns a
 * structured "not available" error instead of failing the turn.
 */

/** Name of the stdio MCP server exposing the web-search tool. */
export const WEB_SEARCH_MCP_SERVER_NAME = "web-search";

/** Path (inside the VM) the server is written to. */
export const WEB_SEARCH_MCP_SERVER_PATH = "/workspace/.swarm/web-search-server.mjs";

/** The tool the agent calls to search the web. */
export const WEB_SEARCH_TOOL = "web_search";

/** The server program, written verbatim into the VM. */
export function webSearchMcpServerSource(): string {
  return [
    "#!/usr/bin/env node",
    "// SwarmAgents web-search MCP stdio server (auto-generated).",
    "// Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.",
    "// Searches run on the host with the run owner's own key; this process",
    "// only holds the per-run token.",
    "",
    "const REQUEST_TIMEOUT_MS = 45000;",
    "",
    "function searchUrl() {",
    "  const explicit = process.env.SWARM_WEB_SEARCH_URL;",
    "  if (explicit) return explicit;",
    "  const base = process.env.ANTHROPIC_BASE_URL || '';",
    "  const marker = '/api/runtime/llm/';",
    "  const at = base.indexOf(marker);",
    "  if (at !== -1) {",
    "    const token = process.env.ANTHROPIC_AUTH_TOKEN || base.slice(at + marker.length).split('/')[0];",
    "    if (token) return base.slice(0, at) + '/api/runtime/web/' + token + '/search';",
    "  }",
    "  const approvalUrl = process.env.SWARM_APPROVAL_URL || '';",
    "  const approvalToken = process.env.SWARM_APPROVAL_TOKEN || '';",
    "  if (approvalUrl && approvalToken) {",
    "    try { return new URL(approvalUrl).origin + '/api/runtime/web/' + approvalToken + '/search'; } catch (err) { /* fall through */ }",
    "  }",
    "  return null;",
    "}",
    "",
    "const tools = [",
    "  {",
    "    name: 'web_search',",
    "    description: 'Search the web. Returns ranked results with title, URL and a short snippet. Use it to look up documentation, error messages and APIs. Requires web search to be configured for this account (Settings); when it is not, the tool returns an error saying so.',",
    "    inputSchema: {",
    "      type: 'object',",
    "      properties: {",
    "        query: { type: 'string', description: 'Search query string.' },",
    "        limit: { type: 'number', description: 'Maximum number of results to return (default 5, max 10).' }",
    "      },",
    "      required: ['query']",
    "    }",
    "  }",
    "];",
    "",
    "function reply(id, result) {",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) + '\\n');",
    "}",
    "",
    "function replyError(id, code, message) {",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }) + '\\n');",
    "}",
    "",
    "function toolResult(payload, isError) {",
    "  return {",
    "    content: [{ type: 'text', text: JSON.stringify(payload) }],",
    "    isError: isError === true",
    "  };",
    "}",
    "",
    "async function callTool(name, args) {",
    "  if (name !== 'web_search') {",
    "    return toolResult({ ok: false, error: 'unknown tool: ' + name }, true);",
    "  }",
    "  const query = typeof args.query === 'string' ? args.query.trim() : '';",
    "  if (!query) {",
    "    return toolResult({ ok: false, error: 'query must be a non-empty string' }, true);",
    "  }",
    "  const url = searchUrl();",
    "  if (!url) {",
    "    return toolResult({ ok: false, error: 'web search host route is not available in this run' }, true);",
    "  }",
    "  const rawLimit = Number(args.limit);",
    "  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;",
    "  let res;",
    "  try {",
    "    res = await fetch(url, {",
    "      method: 'POST',",
    "      headers: { 'Content-Type': 'application/json' },",
    "      body: JSON.stringify(limit ? { query: query, limit: limit } : { query: query }),",
    "      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)",
    "    });",
    "  } catch (err) {",
    "    const msg = err && err.name === 'TimeoutError' ? 'web search timed out' : 'web search request failed';",
    "    return toolResult({ ok: false, error: msg }, true);",
    "  }",
    "  let body = null;",
    "  try { body = await res.json(); } catch (err) { body = null; }",
    "  if (!res.ok || !body || body.ok !== true) {",
    "    const message = body && typeof body.error === 'string' ? body.error : 'web search failed with status ' + res.status;",
    "    return toolResult({ ok: false, error: message }, true);",
    "  }",
    "  return toolResult({ ok: true, results: Array.isArray(body.results) ? body.results : [] }, false);",
    "}",
    "",
    "async function handleMessage(msg) {",
    "  if (!msg || typeof msg !== 'object') return;",
    "  const hasId = msg.id !== undefined && msg.id !== null;",
    "  const method = typeof msg.method === 'string' ? msg.method : '';",
    "  if (method === 'initialize') {",
    "    if (hasId) reply(msg.id, {",
    "      protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',",
    "      capabilities: { tools: {} },",
    "      serverInfo: { name: 'swarm-web-search', version: '1.0.0' }",
    "    });",
    "    return;",
    "  }",
    "  if (method === 'ping') {",
    "    if (hasId) reply(msg.id, {});",
    "    return;",
    "  }",
    "  if (method === 'tools/list') {",
    "    if (hasId) reply(msg.id, { tools: tools });",
    "    return;",
    "  }",
    "  if (method === 'tools/call') {",
    "    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};",
    "    const name = typeof params.name === 'string' ? params.name : '';",
    "    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};",
    "    if (hasId) reply(msg.id, await callTool(name, args));",
    "    return;",
    "  }",
    "  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;",
    "  if (hasId) replyError(msg.id, -32601, 'Method not found: ' + method);",
    "}",
    "",
    "process.stdin.setEncoding('utf8');",
    "let buffer = '';",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  let newline;",
    "  while ((newline = buffer.indexOf('\\n')) !== -1) {",
    "    const line = buffer.slice(0, newline).trim();",
    "    buffer = buffer.slice(newline + 1);",
    "    if (!line) continue;",
    "    let msg;",
    "    try { msg = JSON.parse(line); } catch (err) { continue; }",
    "    handleMessage(msg);",
    "  }",
    "});",
    "",
  ].join("\n");
}
