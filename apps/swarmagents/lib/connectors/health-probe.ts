/**
 * Live MCP health + tool-schema probe for connectors and custom MCP servers.
 *
 * The probe is deliberately bounded (5s ceiling) and server-side only: remote
 * endpoints are checked with the shared SSRF-safe URL validator, stdio servers
 * are spawned inside the caller's VM, and credentials stay in server memory
 * (headers/env handed to the transport, never to the browser). Results carry
 * only ok/latency/tool names+descriptions and generic, redacted errors.
 */

import { makeRedactor } from "../harness/redact";
import type { McpPayload } from "../library/types";
import { validateProviderBaseUrl } from "../providers/url-safety";
import { getVmManager } from "../vm/manager";

/** Hard ceiling: a probe must never hold a route open longer than this. */
export const CONNECTOR_PROBE_TIMEOUT_MS = 5_000;
export const CONNECTOR_PROBE_SCRIPT_PATH = "/workspace/.swarm/connector-health-probe.mjs";
const MAX_TOOLS = 200;
const MAX_DESCRIPTION = 500;

export interface ConnectorProbeTool {
  name: string;
  description: string;
}

export interface ConnectorProbeResult {
  ok: boolean;
  latencyMs: number;
  tools: ConnectorProbeTool[];
  error?: string;
}

export type ConnectorProbeTarget =
  | { transport: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/** The slice of VmManager the probe needs (easy to fake in unit tests). */
export interface ConnectorProbeVm {
  writeFile(userId: string, path: string, content: string): Promise<void>;
  exec(
    userId: string,
    cmd: string[],
    opts?: {
      stdin?: string | Buffer;
      timeoutMs?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ): Promise<{ exitCode: number; truncated?: boolean }>;
}

export interface ConnectorProbeOptions {
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  vm?: ConnectorProbeVm;
  /** Account whose VM runs a stdio probe. */
  userId?: string;
}

/** Generic, non-secret failure detail used by the HTTP probe. */
class ProbeFailure extends Error {}

function fail(error: string, latencyMs: number): ConnectorProbeResult {
  return { ok: false, latencyMs, tools: [], error };
}

function secretValues(target: ConnectorProbeTarget): string[] {
  const values = target.transport === "stdio" ? target.env : target.headers;
  return values ? Object.values(values).filter((v) => typeof v === "string" && v.length >= 6) : [];
}

function toolList(value: unknown, redact: (text: string) => string): ConnectorProbeTool[] {
  if (!Array.isArray(value)) return [];
  const tools: ConnectorProbeTool[] = [];
  for (const raw of value) {
    if (tools.length >= MAX_TOOLS) break;
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name) continue;
    tools.push({
      name: redact(item.name.slice(0, 200)),
      description:
        typeof item.description === "string"
          ? redact(item.description.slice(0, MAX_DESCRIPTION))
          : "",
    });
  }
  return tools;
}

interface JsonRpcMessage {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** Accept both plain JSON and SSE `data:` framed JSON-RPC replies. */
function parseJsonRpc(text: string): JsonRpcMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // fall through to SSE framing
    }
  }
  for (const line of trimmed.split("\n")) {
    const marker = line.indexOf("data:");
    if (marker < 0) continue;
    const payload = line.slice(marker + 5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcMessage;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore keep-alive/comment frames
    }
  }
  return null;
}

async function probeHttp(
  target: Extract<ConnectorProbeTarget, { transport: "http" | "sse" }>,
  options: ConnectorProbeOptions,
  timeoutMs: number,
  elapsed: () => number,
  redact: (text: string) => string,
): Promise<ConnectorProbeResult> {
  const safety = validateProviderBaseUrl(target.url);
  if (!safety.ok) return fail("Endpoint URL failed safety validation.", elapsed());

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(target.headers ?? {}),
  };
  let nextId = 1;
  const rpc = async (method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> => {
    const remaining = Math.max(1, timeoutMs - elapsed());
    const response = await doFetch(safety.url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) throw new ProbeFailure(`Endpoint returned HTTP ${response.status}.`);
    const message = parseJsonRpc(await response.text());
    if (!message) throw new ProbeFailure("MCP server returned an invalid response.");
    return message;
  };

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "swarmagents-health-probe", version: "1.0.0" },
    });
    if (init.error || !init.result) throw new ProbeFailure("MCP initialize failed.");
    const listed = await rpc("tools/list", {});
    if (listed.error || !listed.result) throw new ProbeFailure("MCP tools/list failed.");
    return {
      ok: true,
      latencyMs: elapsed(),
      tools: toolList(listed.result.tools, redact),
    };
  } catch (err) {
    if (err instanceof ProbeFailure) return fail(redact(err.message), elapsed());
    return fail("Endpoint is unreachable.", elapsed());
  }
}

/**
 * stdio MCP servers are never spawned on the Next.js host. The probe writes a
 * tiny JSON-RPC client into the caller's VM and hands it the server config on
 * stdin; stdout carries one sanitized JSON result line.
 */
export const CONNECTOR_PROBE_SCRIPT = String.raw`
import { spawn } from "node:child_process";

const MAX_TOOLS = 200;
let raw = "";
let finished = false;

function finish(result) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(result) + "\n");
}
function tools(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_TOOLS) break;
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name) continue;
    out.push({
      name: item.name.slice(0, 200),
      description: typeof item.description === "string" ? item.description.slice(0, 500) : "",
    });
  }
  return out;
}
async function main() {
  let config;
  try { config = JSON.parse(raw); } catch { finish({ ok: false, tools: [], error: "Invalid probe config." }); return; }
  const timeoutMs = Math.max(1, Math.min(Number(config.timeoutMs) || 5000, 5000));
  const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp", ...(config.env || {}) },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let buffer = "";
  let nextId = 1;
  let settled = false;
  const pending = new Map();

  const stop = () => {
    if (settled) return;
    settled = true;
    try {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 250).unref();
    } catch { /* already exited */ }
  };
  const timer = setTimeout(() => {
    finish({ ok: false, tools: [], error: "Probe timed out." });
    stop();
  }, timeoutMs);

  child.on("error", () => { finish({ ok: false, tools: [], error: "MCP server could not start." }); stop(); });
  child.on("exit", () => { if (!settled) finish({ ok: false, tools: [], error: "MCP server exited before replying." }); stop(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      try {
        const msg = JSON.parse(text);
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* ignore non-JSON stdout noise */ }
    }
  });

  const rpc = (method, params) => new Promise((resolve) => {
    if (settled || !child.stdin || !child.stdin.writable) { resolve(null); return; }
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "swarmagents-health-probe", version: "1.0.0" },
  });
  if (!init || init.error || !init.result) {
    finish({ ok: false, tools: [], error: "MCP initialize failed." });
    clearTimeout(timer);
    stop();
    return;
  }
  const listed = await rpc("tools/list", {});
  if (!listed || listed.error || !listed.result) {
    finish({ ok: false, tools: [], error: "MCP tools/list failed." });
    clearTimeout(timer);
    stop();
    return;
  }
  finish({ ok: true, tools: tools(listed.result.tools) });
  clearTimeout(timer);
  stop();
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => { main().catch(() => finish({ ok: false, tools: [], error: "Probe failed." })); });
`;

async function probeStdio(
  target: Extract<ConnectorProbeTarget, { transport: "stdio" }>,
  options: ConnectorProbeOptions,
  timeoutMs: number,
  elapsed: () => number,
  redact: (text: string) => string,
): Promise<ConnectorProbeResult> {
  const userId = options.userId ?? "local";
  const vm = options.vm ?? getVmManager();
  let stdout = "";
  try {
    await vm.writeFile(userId, CONNECTOR_PROBE_SCRIPT_PATH, CONNECTOR_PROBE_SCRIPT);
    await vm.exec(userId, ["node", CONNECTOR_PROBE_SCRIPT_PATH], {
      stdin: JSON.stringify({
        command: target.command,
        args: target.args ?? [],
        env: target.env ?? {},
        timeoutMs: Math.max(1, timeoutMs - 50),
      }),
      timeoutMs,
      // stderr stays in server memory only: it can contain secret material.
      onStdout: (chunk) => {
        stdout += chunk;
      },
      onStderr: () => {},
    });
  } catch {
    return fail("Virtual machine is unavailable.", elapsed());
  }

  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line || !line.startsWith("{")) return fail("In-VM probe returned no result.", elapsed());
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return fail("In-VM probe returned an invalid result.", elapsed());
  }
  const error =
    typeof parsed.error === "string" && parsed.error
      ? redact(parsed.error.slice(0, 300))
      : undefined;
  return {
    ok: parsed.ok === true && !error,
    latencyMs: elapsed(),
    tools: parsed.ok === true ? toolList(parsed.tools, redact) : [],
    ...(error ? { error } : {}),
  };
}

/** Run a single bounded MCP handshake + tools/list probe. Never throws. */
export async function probeConnectorHealth(
  target: ConnectorProbeTarget,
  options: ConnectorProbeOptions = {},
): Promise<ConnectorProbeResult> {
  const timeoutMs = Math.min(
    CONNECTOR_PROBE_TIMEOUT_MS,
    Math.max(1, Math.floor(options.timeoutMs ?? CONNECTOR_PROBE_TIMEOUT_MS)),
  );
  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  const redact = makeRedactor(undefined, secretValues(target));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ConnectorProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve(fail(`Probe timed out after ${timeoutMs} ms.`, elapsed())),
      timeoutMs,
    );
  });
  const work =
    target.transport === "stdio"
      ? probeStdio(target, options, timeoutMs, elapsed, redact)
      : probeHttp(target, options, timeoutMs, elapsed, redact);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PLACEHOLDER = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const EXACT_PLACEHOLDER = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

/**
 * Build a probe target from an installed MCP payload. Only declared fields are
 * opened from the sealed store, and secrets land in server-memory headers/env
 * (never in the returned result or in a response). `$FIELD` args are expanded
 * as data, never through a shell.
 */
export function buildProbeTarget(
  payload: McpPayload,
  secrets: Record<string, string>,
): ConnectorProbeTarget {
  const declared = (payload.requiredFields ?? []).map((field) => field.key);
  const available: Record<string, string> = {};
  for (const key of declared) {
    if (key && Object.hasOwn(secrets, key)) available[key] = secrets[key];
  }
  const declaredSet = new Set(declared);
  const expand = (arg: string): string =>
    arg.replace(PLACEHOLDER, (match, braced: string | undefined, bare: string | undefined) => {
      const key = braced ?? bare;
      if (!key || !declaredSet.has(key)) return match;
      return Object.hasOwn(available, key) ? available[key] : match;
    });

  if (payload.transport === "http") {
    return {
      transport: "http",
      url: payload.url ?? "",
      headers: Object.keys(available).length > 0 ? available : undefined,
    };
  }
  const args = (payload.args ?? []).map((arg) => {
    const quote = arg.length >= 2 ? arg[0] : "";
    const quoted = (quote === '"' || quote === "'") && arg.endsWith(quote);
    const inner = quoted ? arg.slice(1, -1) : arg;
    const exact = EXACT_PLACEHOLDER.exec(inner);
    if (exact) {
      const key = exact[1] ?? exact[2];
      if (declaredSet.has(key) && Object.hasOwn(available, key)) return available[key];
    }
    return expand(arg);
  });
  return {
    transport: "stdio",
    command: payload.command ?? "",
    args,
    env: Object.keys(available).length > 0 ? available : undefined,
  };
}
