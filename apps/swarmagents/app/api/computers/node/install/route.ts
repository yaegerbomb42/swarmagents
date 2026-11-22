/**
 * One-line installer for a paired computer.
 *
 * GET /api/computers/node/install?os=linux|macos|windows
 *
 * The script redeems the pairing code from --code, stores the node token in
 * ~/.swarmagents/computer.json (mode 600), then keeps the computer online with
 * a heartbeat and claims/executes runs with the local `claude` CLI. It is plain
 * text so it can be piped into sh (POSIX) or invoked as a PowerShell
 * scriptblock. No secret is embedded in the script: the code is passed on the
 * command line and the token is written only to the node's own config file.
 *
 * The POSIX worker heartbeats from a background thread while `claude` runs,
 * streams `--output-format stream-json` events back as `action: "event"`, and
 * resumes the previous session with `--resume` so multi-turn runs keep their
 * context.
 *
 * This path is in the middleware public allow-list (the pairing code is the
 * credential at this stage).
 */

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } as const;

const SHELL_SCRIPT = String.raw`#!/bin/sh
# SwarmAgents computer installer: pair, save the node token, then serve runs.
set -eu
CODE=""
SERVER="https://swarmagents.codes"
MODE="host"
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$CODE" ]; then
  echo "Missing --code. Create a pairing code in Settings > Computers." >&2
  exit 1
fi
case "$CODE" in
  *[!A-Za-z0-9-]*) echo "Invalid pairing code." >&2; exit 1 ;;
esac
# --mode is interpolated into the pairing JSON, so accept only the known
# values. Anything else (quotes, braces, arbitrary text) fails closed before
# the request is made.
case "$MODE" in
  host|docker|sandbox) ;;
  *) echo "Invalid --mode. Use host, docker or sandbox." >&2; exit 2 ;;
esac
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to pair and serve runs. Install it and run this command again." >&2
  exit 1
fi
OS=linux
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
esac
ARCH=$(uname -m 2>/dev/null || echo unknown)
PAYLOAD=$(printf '{"code":"%s","machine":{"os":"%s","arch":"%s","mode":"%s"}}' "$CODE" "$OS" "$ARCH" "$MODE")
RESP=$(curl -fsSL -X POST -H "content-type: application/json" --data "$PAYLOAD" "$SERVER/api/computers/pair") || {
  echo "Pairing failed. The code may be expired or already used." >&2
  exit 1
}
# Parse with python3: node tokens are mixed-case hex, so a lowercase-only sed
# pattern silently dropped every token that contained an uppercase digit.
PARSED=$(printf '%s' "$RESP" | python3 -c '
import json, re, sys
try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(body, dict):
    sys.exit(1)
computer = body.get("computer")
cid = computer.get("id") if isinstance(computer, dict) else ""
if not cid:
    cid = body.get("computerId") or body.get("id") or ""
token = body.get("nodeToken") or ""
if not isinstance(cid, str) or not cid.startswith("cmp_"):
    sys.exit(1)
if not isinstance(token, str) or not re.fullmatch(r"[A-Fa-f0-9]{64}", token):
    sys.exit(1)
print(cid)
print(token)
') || {
  echo "Pairing response was not understood." >&2
  exit 1
}
CID=""
TOKEN=""
{
  IFS= read -r CID
  IFS= read -r TOKEN
} <<EOF
$PARSED
EOF
if [ -z "$CID" ] || [ -z "$TOKEN" ]; then
  echo "Pairing response was not understood." >&2
  exit 1
fi
DIR="$HOME/.swarmagents"
mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true
CONFIG="$DIR/computer.json"
printf '{"computerId":"%s","nodeToken":"%s","server":"%s"}\n' "$CID" "$TOKEN" "$SERVER" > "$CONFIG"
chmod 600 "$CONFIG"
echo "Paired as $CID. Keeping this computer online (Ctrl-C to stop)."
exec python3 - "$SERVER" "$CID" "$TOKEN" "$OS" "$ARCH" "$MODE" <<'PY'
import json, os, signal, subprocess, sys, threading, time, urllib.request

server, cid, token, os_name, arch, mode = sys.argv[1:7]
endpoint = server + "/api/computers/node"
headers = {
    "content-type": "application/json",
    "authorization": "Bearer " + token,
    "x-computer-id": cid,
}
machine = {"os": os_name, "arch": arch, "mode": mode}

def post(payload, timeout=60):
    req = urllib.request.Request(
        endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
    except urllib.error.HTTPError as exc:
        # The node has been revoked — exit instead of looping forever.
        if exc.code == 401:
            os._exit(0)
        raise
    return json.loads(raw.decode() or "{}")

def heartbeat_loop():
    # The claim/execute loop blocks while claude runs. Without this thread the
    # node stops heartbeating and the server pauses the run after its 60s
    # offline window.
    while True:
        try:
            post({"action": "heartbeat", "machine": machine})
        except Exception:
            pass
        time.sleep(20)

threading.Thread(target=heartbeat_loop, daemon=True).start()

# Buffered event stream: emit() never blocks the stdout drain on an HTTP
# request. A flusher thread posts batches every ~150ms (or immediately once
# 10 events are queued) to the batch endpoint.
# send_lock serializes outgoing event batches and drain_events so the final drain
# completes and flushes before complete() is called.
FLUSH_BATCH = 10
event_queue = []
event_lock = threading.Lock()
send_lock = threading.Lock()
flush_poke = threading.Event()

def emit_now(pending):
    with send_lock:
        if len(pending) == 1:
            single = pending[0]
            post({"action": "event", "runId": single["runId"], "event": single["event"]})
        elif pending:
            post({"action": "events", "events": pending})

def emit_flush_loop():
    while True:
        flush_poke.wait(0.15)
        flush_poke.clear()
        with event_lock:
            pending = event_queue[:]
            event_queue.clear()
        if not pending:
            continue
        try:
            emit_now(pending)
        except Exception:
            pass

threading.Thread(target=emit_flush_loop, daemon=True).start()

def emit(run_id, event):
    with event_lock:
        event_queue.append({"runId": run_id, "event": event})
        if len(event_queue) >= FLUSH_BATCH:
            flush_poke.set()

def drain_events():
    # Flush everything queued before the run is completed, so events arrive
    # in order ahead of the completion signal.
    with event_lock:
        pending = event_queue[:]
        event_queue.clear()
    if pending:
        try:
            emit_now(pending)
        except Exception:
            pass

def usage_event(message):
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return None
    event = {
        "type": "usage",
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
    }
    cached = usage.get("cache_read_input_tokens")
    if isinstance(cached, int):
        event["cachedTokens"] = cached
    model = message.get("model")
    if isinstance(model, str) and model:
        event["model"] = model
    return event

def tool_output(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if (
                isinstance(part, dict)
                and part.get("type") == "text"
                and isinstance(part.get("text"), str)
            ):
                parts.append(part["text"])
        return "\n".join(parts)
    if content is None:
        return ""
    try:
        return json.dumps(content)
    except Exception:
        return str(content)

def stream_events(raw):
    # Map claude stream-json objects onto the canonical telemetry names the
    # server/UI already understand (see lib/harness/types.ts).
    events = []
    kind = raw.get("type")
    if kind == "assistant":
        message = raw.get("message")
        if not isinstance(message, dict):
            return events
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    events.append({"type": "assistant.text", "text": block["text"][:200000]})
                elif block.get("type") == "tool_use":
                    event = {
                        "type": "tool.call",
                        "name": block.get("name") if isinstance(block.get("name"), str) else "",
                        "input": block.get("input"),
                    }
                    if isinstance(block.get("id"), str):
                        event["id"] = block["id"]
                    events.append(event)
        usage = usage_event(message)
        if usage:
            events.append(usage)
    elif kind == "user":
        message = raw.get("message")
        if not isinstance(message, dict):
            return events
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                event = {
                    "type": "tool.result",
                    "ok": block.get("is_error") is not True,
                    "truncated": False,
                    "output": tool_output(block)[:50000],
                }
                if isinstance(block.get("tool_use_id"), str):
                    event["id"] = block["tool_use_id"]
                events.append(event)
    return events

def complete(run_id, status, code, text="", error="", meta=None):
    result = {
        "status": status,
        "exitCode": code,
        "text": text[-200000:],
        "error": error[:2000],
    }
    if meta:
        for key in ("sessionId", "costUsd", "durationMs", "numTurns"):
            if meta.get(key) is not None:
                result[key] = meta[key]

    # Retry complete() with bounded exponential backoff on transient errors (non-4xx)
    backoff = 0.5
    for attempt in range(5):
        try:
            with send_lock:
                post({"action": "complete", "runId": run_id, "result": result})
            return
        except urllib.error.HTTPError as exc:
            # 4xx client errors (400, 404, 409 etc) mean the server rejected or the run ended; don't loop
            if 400 <= exc.code < 500:
                break
        except Exception:
            pass
        if attempt < 4:
            time.sleep(backoff)
            backoff = min(backoff * 2, 8.0)

# SIGTERM/SIGINT: terminate the claude child process group cleanly instead of orphaning it.
current_proc = [None]

def _worker_signal(signum, frame):
    proc = current_proc[0]
    try:
        if proc is not None and proc.poll() is None:
            if hasattr(os, "killpg"):
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                if hasattr(os, "killpg"):
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    proc.kill()
    finally:
        os._exit(0)

signal.signal(signal.SIGTERM, _worker_signal)
signal.signal(signal.SIGINT, _worker_signal)

def run_job(job):
    run_id = job.get("runId")
    if not isinstance(run_id, str) or not run_id:
        return
    prompt = job.get("prompt")
    if not isinstance(prompt, str):
        prompt = ""
    session_id = job.get("sessionId")

    cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose"]
    if isinstance(session_id, str) and session_id:
        cmd += ["--resume", session_id]
    # Pass the prompt after -- so values starting with "-" are never flags.
    cmd += ["--", prompt]

    started = time.time()
    meta = {}
    if isinstance(session_id, str) and session_id:
        meta["sessionId"] = session_id
    text_parts = []
    saw_text_event = False
    stderr_parts = []

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
    except FileNotFoundError:
        complete(run_id, "error", 127, "", "claude is not installed on this computer.", meta)
        return
    except Exception as exc:
        complete(run_id, "error", 1, "", str(exc), meta)
        return

    current_proc[0] = proc

    def drain_stderr(pipe):
        try:
            for line in pipe:
                stderr_parts.append(line)
                if len(stderr_parts) > 400:
                    del stderr_parts[:200]
        except Exception:
            pass

    stderr_thread = threading.Thread(target=drain_stderr, args=(proc.stderr,), daemon=True)
    stderr_thread.start()

    # Preserve the old 3600s wall-clock cap without blocking the stream.
    watchdog = threading.Timer(3600, proc.kill)
    watchdog.daemon = True
    watchdog.start()

    try:
        for line in proc.stdout:
            if time.time() - started > 3600:
                proc.kill()
                break
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except Exception:
                continue
            if not isinstance(raw, dict):
                continue
            session = raw.get("session_id")
            if isinstance(session, str) and session:
                meta["sessionId"] = session
            for event in stream_events(raw):
                if event.get("type") == "assistant.text":
                    text_parts.append(event.get("text", ""))
                    saw_text_event = True
                emit(run_id, event)
            if raw.get("type") == "result":
                cost = raw.get("total_cost_usd")
                if not isinstance(cost, (int, float)):
                    cost = raw.get("cost_usd")
                if isinstance(cost, (int, float)):
                    meta["costUsd"] = cost
                duration = raw.get("duration_ms")
                if isinstance(duration, (int, float)):
                    meta["durationMs"] = int(duration)
                turns = raw.get("num_turns")
                if isinstance(turns, (int, float)):
                    meta["numTurns"] = int(turns)
    finally:
        watchdog.cancel()
        try:
            proc.wait(timeout=30)
        except Exception:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
        stderr_thread.join(timeout=2)
        current_proc[0] = None
        drain_events()

    code = proc.returncode if isinstance(proc.returncode, int) else 1
    text = "".join(text_parts)
    # The stream already delivered assistant text, so resending it on complete
    # would duplicate the transcript. Only fall back when nothing streamed.
    reported = "" if saw_text_event else text
    if code == 0:
        complete(run_id, "finished", 0, reported, "", meta)
    else:
        error = "".join(stderr_parts).strip()
        if not error:
            error = "claude exited with code " + str(code) + "."
        complete(run_id, "error", code, reported, error, meta)

while True:
    job = None
    try:
        reply = post({"action": "claim"}, timeout=30)
        job = reply.get("job") if isinstance(reply, dict) else None
    except Exception:
        job = None
    if job:
        run_job(job)
    else:
        time.sleep(3)
PY
`;

const POWERSHELL_SCRIPT = `param([string]$Code, [string]$Server = "https://swarmagents.codes", [string]$Mode = "host")
$ErrorActionPreference = "Stop"
if (-not $Code) { Write-Error "Missing -Code. Create a pairing code in Settings > Computers."; exit 1 }
$machine = @{ os = "windows"; arch = $env:PROCESSOR_ARCHITECTURE; mode = $Mode }
$pairBody = @{ code = $Code; machine = $machine } | ConvertTo-Json -Depth 4
try {
  $pair = Invoke-RestMethod -Method Post -Uri "$Server/api/computers/pair" -ContentType "application/json" -Body $pairBody
} catch {
  Write-Error "Pairing failed. The code may be expired or already used."
  exit 1
}
$dir = Join-Path $HOME ".swarmagents"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$config = @{ computerId = $pair.computer.id; nodeToken = $pair.nodeToken; server = $Server } | ConvertTo-Json
Set-Content -Path (Join-Path $dir "computer.json") -Value $config -Encoding utf8
Write-Host "Paired as $($pair.computer.id). Keeping this computer online (Ctrl-C to stop)."
$headers = @{ Authorization = "Bearer $($pair.nodeToken)"; "x-computer-id" = $pair.computer.id }
$node = "$Server/api/computers/node"
while ($true) {
  try {
    Invoke-RestMethod -Method Post -Uri $node -Headers $headers -ContentType "application/json" -Body (@{ action = "heartbeat"; machine = $machine } | ConvertTo-Json -Depth 4) | Out-Null
  } catch {}
  $claim = $null
  try { $claim = Invoke-RestMethod -Method Post -Uri $node -Headers $headers -ContentType "application/json" -Body (@{ action = "claim" } | ConvertTo-Json) } catch {}
  if ($claim -and $claim.job) {
    $job = $claim.job
    $status = "finished"
    $code = 0
    $text = ""
    $errorText = ""
    try {
      $text = (& claude -p $job.prompt 2>&1 | Out-String)
      $code = $LASTEXITCODE
      if ($code -ne 0) { $status = "error" }
    } catch {
      $code = 127
      $status = "error"
      $errorText = "claude is not installed on this computer."
    }
    try {
      $body = @{ action = "complete"; runId = $job.runId; result = @{ status = $status; exitCode = $code; text = $text; error = $errorText } } | ConvertTo-Json -Depth 5
      Invoke-RestMethod -Method Post -Uri $node -Headers $headers -ContentType "application/json" -Body $body | Out-Null
    } catch {}
  }
  Start-Sleep -Seconds 3
}
`;

export async function GET(req: NextRequest) {
  const os = (req.nextUrl.searchParams.get("os") ?? "linux").toLowerCase();
  const body = os === "windows" ? POWERSHELL_SCRIPT : SHELL_SCRIPT;
  return new Response(body, { headers: NO_STORE });
}
