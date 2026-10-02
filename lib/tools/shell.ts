import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sessionDir, newId } from "../store";
import { redactSavedKeys } from "../connections";
import { clip, type Tool } from "./types";
import { identity, sandboxCommand, sandboxEnv } from "../sandbox";

const MARK = "__SWARM_CWD__";

/** Secrets the agent must never see in its shell children. The server holds the owner token so the
 *  browser doesn't have to; children inherit env by default, so strip server-only keys explicitly.
 *  SWARM_HOME is safe (session data dir) and stays so uploads/sessions keep working. */
const STRIPPED_ENV = new Set(["SWARM_AUTH_TOKEN", "SWARM_AUTH_TOKEN_SHA256"]);
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
  };
  for (const [k, v] of Object.entries(process.env)) {
    if (k in env) continue;
    // Server-only secrets never reach agent children. SWARM_HOME is the session data dir and stays.
    if (k === "SWARM_HOME") {
      if (v !== undefined) env[k] = v;
      continue;
    }
    if (STRIPPED_ENV.has(k) || k.startsWith("SWARM_")) continue;
    if (v !== undefined) env[k] = v;
  }
  // per-user sandbox: on a server the child gets its own HOME/TMPDIR and no pointer into server data.
  const sb = sandboxEnv();
  if (Object.keys(sb).length) delete env.SWARM_HOME;
  Object.assign(env, sb);
  // NOTE: saved tool keys are deliberately NOT exported here. The coordinator declined global
  // saved-key injection into the shell env (GROUP_CHAT 19:38): an agent-run `env` would expose every
  // saved credential at once. Keys stay reachable through api_request (host-scoped) and MCP per-server
  // auth; output paths are still passed through redactSavedKeys so no key reaches the transcript.
  return env;
}

// ---- 24h growth guards: a long run must not fill memory or disk ----

/** Foreground output kept in memory before the older part is spilled to disk. */
export const CAPTURE_BYTES = 4 * 1024 * 1024;
/** Newest slice of the capture always kept in memory (it holds the trailing cwd marker). */
export const CAPTURE_TAIL_BYTES = 1024 * 1024;
/** Live output forwarded to the tool card; past this the full log is on disk instead. */
export const STREAM_BYTES = 256 * 1024;
/** Total out-*.log + bg-*.log budget per session. */
export const LOG_BUDGET_BYTES = 200 * 1024 * 1024;
/** Head kept when an oversized log is shrunk in place (startup errors are the useful part). */
export const LOG_HEAD_BYTES = 64 * 1024;
/** A log touched this recently may still be written, so it is not simply deleted. */
export const ACTIVE_LOG_MS = 10 * 60 * 1000;

export const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1 << 10 ? `${Math.round(n / 1024)} KB` : `${n} B`);

interface LogFile {
  f: string;
  size: number;
  mtime: number;
}

function sessionLogs(sessionId: string): LogFile[] {
  const dir = sessionDir(sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogFile[] = [];
  for (const n of names) {
    if (!/^(out|bg)-.*\.log$/.test(n)) continue;
    const f = path.join(dir, n);
    try {
      const st = fs.statSync(f);
      out.push({ f, size: st.size, mtime: st.mtimeMs });
    } catch {
      // raced with a delete; ignore
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** Keep a session's shell logs inside LOG_BUDGET_BYTES. Settled logs are deleted oldest-first; a log
 *  that may still be appended to is shrunk in place (head kept) instead, because deleting a file that
 *  an open writer still holds does not reclaim its blocks on unix. Returns bytes reclaimed. */
export function pruneLogs(sessionId: string): number {
  const logs = sessionLogs(sessionId);
  let total = logs.reduce((n, l) => n + l.size, 0);
  if (total <= LOG_BUDGET_BYTES) return 0;
  const before = total;
  const now = Date.now();
  for (const l of logs) {
    if (total <= LOG_BUDGET_BYTES) break;
    if (now - l.mtime < ACTIVE_LOG_MS) continue;
    try {
      fs.rmSync(l.f, { force: true });
      total -= l.size;
    } catch {}
  }
  for (const l of logs) {
    if (total <= LOG_BUDGET_BYTES) break;
    if (now - l.mtime >= ACTIVE_LOG_MS) continue;
    try {
      if (l.size <= LOG_HEAD_BYTES) continue;
      // Read only the head: the log may be hundreds of MB and must not be loaded whole.
      const fd = fs.openSync(l.f, "r");
      const head = Buffer.alloc(Math.min(LOG_HEAD_BYTES, l.size));
      let n = 0;
      try {
        n = fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      fs.writeFileSync(l.f, head.subarray(0, n));
      total -= l.size - n;
    } catch {}
  }
  return before - total;
}

/** Disk footprint of a session's shell logs (used by tests and diagnostics). */
export function logUsage(sessionId: string): { files: number; bytes: number } {
  const logs = sessionLogs(sessionId);
  return { files: logs.length, bytes: logs.reduce((n, l) => n + l.size, 0) };
}

// Background jobs the agent started, per session, so they can be stopped with the task.
const bgProcs = new Map<string, Set<number>>();

function trackBackground(sessionId: string, child: { pid?: number; on(ev: string, cb: () => void): void }) {
  if (!child.pid) return;
  const set = bgProcs.get(sessionId) ?? new Set<number>();
  set.add(child.pid);
  bgProcs.set(sessionId, set);
  child.on("exit", () => {
    set.delete(child.pid!);
    if (!set.size) bgProcs.delete(sessionId);
    pruneLogs(sessionId);
  });
}

export function backgroundCount(sessionId: string): number {
  return bgProcs.get(sessionId)?.size ?? 0;
}

/** Stop every background job this session started (kills the whole process group). Returns how many. */
export function killSessionBackground(sessionId: string): number {
  const set = bgProcs.get(sessionId);
  if (!set) return 0;
  let killed = 0;
  for (const pid of set) {
    try {
      process.kill(-pid, "SIGTERM");
      killed++;
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 3000);
  }
  bgProcs.delete(sessionId);
  return killed;
}

export const shell: Tool = {
  spec: {
    name: "bash",
    description:
      "Run a shell command (zsh, login env) on the user's Mac. Working directory persists between calls (cd works). Output streams live to the user. Use for git, builds, tests, package managers, scripts, opening apps, anything. Set background=true for servers/watchers; it returns immediately with a log path you can read later.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_sec: { type: "number", description: "Default 600." },
        background: { type: "boolean" },
      },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const cmd = String(input.command ?? "");
    const dir = sessionDir(ctx.sessionId);
    const spill = (full: string) => {
      const f = path.join(dir, `out-${newId()}.log`);
      fs.writeFileSync(f, full);
      pruneLogs(ctx.sessionId);
      return f;
    };
    if (input.background) {
      // per-user sandbox: the session dir is server-private there, so put the log where the agent can read it.
      const id = identity();
      const logDir = id ? path.join(id.workspace, ".swarm-logs") : dir;
      if (id) fs.mkdirSync(logDir, { recursive: true });
      const log = path.join(logDir, `bg-${newId()}.log`);
      const fd = fs.openSync(log, "a");
      if (id) fs.fchownSync(fd, id.uid, id.gid);
      const sb = sandboxCommand("/bin/zsh", ["-lc", cmd]);
      const child = spawn(sb.command, sb.args, { cwd: ctx.cwd, detached: true, stdio: ["ignore", fd, fd], env: childEnv() });
      trackBackground(ctx.sessionId, child);
      pruneLogs(ctx.sessionId);
      child.unref();
      return { content: `Started in background (pid ${child.pid}). Log: ${log}` };
    }
    const timeout = Math.max(1, Number(input.timeout_sec ?? 600)) * 1000;
    return new Promise((resolve) => {
      // per-user sandbox: runs as the user's own uid on a server (unchanged locally).
      const sb = sandboxCommand("/bin/zsh", ["-lc", `${cmd}\n__rc=$?; printf '\\n${MARK}%s' "$PWD"; exit $__rc`]);
      const child = spawn(sb.command, sb.args, {
        cwd: ctx.cwd,
        env: childEnv(),
        // Own process group, so stop/timeout kills the whole pipeline, not just zsh.
        detached: true,
      });
      // Rolling capture: older output is spilled to disk the moment it passes CAPTURE_BYTES, so a
      // command that runs for hours cannot grow this process without bound. The newest slice stays in
      // memory (it carries the cwd marker), and the whole stream still ends up on disk.
      let out = "";
      let spillPath = "";
      let spillFd = -1;
      let dropped = 0;
      let streamed = 0;
      let streamNotified = false;

      const capture = (s: string) => {
        out += s;
        if (out.length <= CAPTURE_BYTES) return;
        if (spillFd < 0) {
          spillPath = path.join(dir, `out-${newId()}.log`);
          spillFd = fs.openSync(spillPath, "a");
        }
        const cut = out.length - CAPTURE_TAIL_BYTES;
        try {
          // Saved keys are redacted before anything reaches disk, so a later read_file cannot leak them.
          fs.writeSync(spillFd, redactSavedKeys(out.slice(0, cut)));
        } catch {}
        dropped += cut;
        out = out.slice(cut);
      };

      // Live feed to the user, batched so the key redactor runs a few times a second rather than on
      // every chunk. The tool card stores exactly what it is handed, so this is where keys must go.
      let pending = "";
      let flushTimer: NodeJS.Timeout | null = null;
      const flush = () => {
        flushTimer = null;
        if (!pending) return;
        const s = redactSavedKeys(pending);
        pending = "";
        if (!s) return;
        if (streamed >= STREAM_BYTES) {
          if (!streamNotified) {
            streamNotified = true;
            ctx.onOutput(`\n[live output capped at ${fmtSize(STREAM_BYTES)} — the final result and the session log hold the rest]\n`);
          }
          return;
        }
        const slice = s.slice(0, STREAM_BYTES - streamed);
        streamed += slice.length;
        ctx.onOutput(slice);
      };
      const onData = (d: Buffer) => {
        const s = d.toString();
        capture(s);
        const visible = s.split(MARK)[0];
        if (!visible) return;
        pending += visible;
        if (!flushTimer) flushTimer = setTimeout(flush, 250);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const kill = () => {
        for (const sig of ["SIGTERM", "SIGKILL"] as const)
          setTimeout(() => {
            try {
              process.kill(-child.pid!, sig);
            } catch {}
          }, sig === "SIGKILL" ? 3000 : 0);
      };
      const timer = setTimeout(() => {
        out += `\n[timed out after ${timeout / 1000}s]`;
        kill();
      }, timeout);
      ctx.signal.addEventListener("abort", kill, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (flushTimer) {
          clearTimeout(flushTimer);
          flush();
        }
        const i = out.lastIndexOf(MARK);
        if (i >= 0) {
          const nextDir = out.slice(i + MARK.length).trim();
          if (nextDir && fs.existsSync(nextDir)) ctx.setCwd(nextDir);
          out = out.slice(0, i);
        }
        // One canonical redaction pass covers both what the model sees and what lands on disk.
        out = redactSavedKeys(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
        if (spillFd >= 0) {
          // Finish the one full log on disk, then point at it instead of writing a second file.
          try {
            fs.writeSync(spillFd, out);
            fs.closeSync(spillFd);
          } catch {}
          spillFd = -1;
          pruneLogs(ctx.sessionId);
        }
        const note = dropped ? `[earlier output (${fmtSize(dropped)}) saved to ${spillPath}]\n` : "";
        const body = `${note}${out || "(no output)"}\n[exit ${code ?? "killed"} · cwd ${ctx.cwd}]`;
        const content = spillPath && dropped ? (body.length > 30_000 ? clip(body, 30_000, () => spillPath) : body) : clip(body, 30_000, spill);
        resolve({ content, isError: code !== 0 });
      });
    });
  },
};
