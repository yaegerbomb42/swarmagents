/**
 * Terminal exec: run a single user-typed command in their VM.
 *
 * POST /api/runtime/vm/exec {cmd: string | string[]} -> {runId}
 * DELETE /api/runtime/vm/exec?runId=<id> -> cancels the in-flight shell run
 *
 * - `cmd` may be a raw shell line ("ls -la | wc -l") or an argv array
 *   (["ls", "-la"]). A string is executed as ["bash", "-lc", line] inside the
 *   user's VM, so quotes, pipes and redirections keep their shell meaning.
 * - Commands run through VmManager via argv — exactly like the harness's exec.
 * - The risk classifier (lib/harness/risk) is applied first: deny-classified
 *   commands never run; ask-classified ones (privileged, network-mutating,
 *   destructive) are refused with a reason — take those to the agent prompt.
 * - Output streams onto the telemetry bus under a dedicated "shell" run,
 *   consumed by the client at /api/runtime/stream/[runId].
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getRuntimeManager } from "../../../../../lib/runtime/manager";
import { classifyCommand } from "../../../../../lib/harness/risk";
import {
  shellCommandText,
  SHELL_MAX_ARGS,
  SHELL_MAX_ARG_LEN,
  SHELL_MAX_CMD_LEN,
} from "../../../../../lib/vm/argv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

/**
 * Normalize the body's cmd field into an argv array; returns a 400 message on
 * failure. A string is a raw shell line and runs through `bash -lc`, preserving
 * quotes/pipes/redirections; an array is an already-parsed argv and runs as-is.
 */
function normalizeCmd(
  raw: unknown,
): { argv: string[]; source: string; shellLine: boolean } | { error: string } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { error: "cmd is required." };
    return { argv: ["bash", "-lc", trimmed], source: trimmed, shellLine: true };
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { error: "cmd is required." };
    const argv: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") return { error: "cmd array entries must be strings." };
      if (item.length === 0) return { error: "cmd array entries must be non-empty." };
      argv.push(item);
    }
    return { argv, source: shellCommandText(argv), shellLine: false };
  }
  return { error: "cmd must be a string or an array of strings." };
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400 });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const normalized = normalizeCmd(body.cmd);
  if ("error" in normalized) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const { argv, source, shellLine } = normalized;

  // Limits: no NUL bytes, sane arg count / lengths, and a total cap.
  if (source.includes("\0")) {
    return NextResponse.json({ error: "cmd contains NUL bytes." }, { status: 400 });
  }
  if (argv.length > SHELL_MAX_ARGS) {
    return NextResponse.json({ error: `cmd has too many arguments (max ${SHELL_MAX_ARGS}).` }, { status: 400 });
  }
  // A raw shell line is one argument to `bash -lc`; only its total length is
  // capped (SHELL_MAX_CMD_LEN). API callers sending argv keep per-arg limits.
  if (!shellLine) {
    for (const arg of argv) {
      if (Buffer.byteLength(arg, "utf8") > SHELL_MAX_ARG_LEN) {
        return NextResponse.json({ error: `an argument is too long (max ${SHELL_MAX_ARG_LEN} bytes).` }, { status: 400 });
      }
    }
  }
  if (source.length > SHELL_MAX_CMD_LEN) {
    return NextResponse.json({ error: "cmd is too long." }, { status: 400 });
  }

  // Risk gate: deny never runs; ask (privileged/destructive/network) is
  // refused with a reason — the terminal is for the user's own exploration,
  // and anything a human needs approved belongs in the agent prompt.
  const risk = classifyCommand(source);
  if (risk.level === "deny" || risk.level === "ask") {
    return NextResponse.json(
      {
        error:
          risk.level === "deny"
            ? risk.reason
            : `${risk.reason} — refused from the terminal; run it through the agent prompt instead.`,
        level: risk.level,
      },
      { status: 403 },
    );
  }

  const manager = getRuntimeManager();
  const { runId } = manager.execShell(user, argv, source);

  // If the client goes away (for example the terminal's Ctrl-C aborts the
  // fetch), stop the command in the VM rather than letting it run unobserved.
  if (req.signal.aborted) {
    manager.cancelShell(user, runId);
  } else {
    req.signal.addEventListener("abort", () => manager.cancelShell(user, runId), { once: true });
  }

  return NextResponse.json({ runId }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const runId = new URL(req.url).searchParams.get("runId") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }

  const result = getRuntimeManager().cancelShell(user, runId);
  if (!result.ok) {
    return NextResponse.json({ error: "Run not found or not active." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, runId: result.runId });
}
