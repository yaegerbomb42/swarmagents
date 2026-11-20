#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for the SwarmAgents VM image.
 *
 * Installed at /usr/local/bin/swarm-approval-hook and registered (read-only)
 * by /etc/claude-code/managed-settings.json, so the agent cannot disable it.
 * Claude Code runs this before every tool call and blocks on its exit:
 *
 *   stdin  <- { session_id, cwd, hook_event_name, tool_name, tool_input, ... }
 *   stdout -> { hookSpecificOutput: { hookEventName, permissionDecision, ... } }
 *
 * The script forwards the call to the harness inside the app and waits for a
 * synchronous allow/deny verdict. The harness authenticates the request with
 * the per-run token in SWARM_APPROVAL_TOKEN; the classifier and the user's
 * approval card live there. Nothing is executed before this process exits.
 *
 * Fail closed: missing configuration, a network error, a non-2xx response, an
 * invalid response, or the local timeout all return "deny". The timeout is
 * longer than the harness approval TTL, so a timeout is normally the harness
 * returning its own deny first; this one is the last-resort guard.
 *
 * Node 22 provides the global fetch, so the script has no dependencies.
 */

"use strict";

const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 305_000;
const MAX_TIMEOUT_MS = 3_500_000;

function timeoutMs() {
  const raw = Number(process.env.SWARM_APPROVAL_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}

/** Print a PreToolUse decision and exit 0 (the documented JSON form). */
function decide(permissionDecision, reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
    },
  };
  if (reason) output.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

function deny(reason) {
  decide("deny", reason);
}

async function main(payloadText) {
  const url = (process.env.SWARM_APPROVAL_URL || "").trim();
  const token = (process.env.SWARM_APPROVAL_TOKEN || "").trim();
  if (!url || !token) {
    // Outside a harness-managed run there is no way to ask anyone; refuse.
    deny("Approval channel is not configured for this run.");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    deny("Approval hook received malformed input.");
    return;
  }
  if (!payload || typeof payload !== "object" || typeof payload.tool_name !== "string" || !payload.tool_name) {
    deny("Approval hook received no tool name.");
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  timer.unref?.();

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool_name: payload.tool_name,
        tool_input: payload.tool_input ?? {},
        session_id: typeof payload.session_id === "string" ? payload.session_id : undefined,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        tool_use_id: typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    deny(aborted
      ? "Approval request timed out; the tool call was not run."
      : "Could not reach the approval service; the tool call was not run.");
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    deny(`Approval service returned HTTP ${res.status}; the tool call was not run.`);
    return;
  }

  let verdict;
  try {
    verdict = await res.json();
  } catch {
    deny("Approval service returned an invalid response; the tool call was not run.");
    return;
  }

  if (verdict && verdict.decision === "allow") {
    decide("allow");
    return;
  }
  const reason = verdict && typeof verdict.reason === "string" && verdict.reason
    ? verdict.reason
    : "Denied by the SwarmAgents approval gate.";
  deny(`SwarmAgents blocked this tool call: ${reason}`);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    deny("Approval hook input was too large.");
  }
});
process.stdin.on("end", () => {
  main(input).catch(() => deny("Approval hook failed; the tool call was not run."));
});
process.stdin.on("error", () => {
  deny("Approval hook could not read its input; the tool call was not run.");
});
