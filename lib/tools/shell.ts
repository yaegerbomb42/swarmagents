import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sessionDir, newId } from "../store";
import { clip, type Tool } from "./types";

const MARK = "__SWARM_CWD__";

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
    const spill = (full: string) => {
      const f = path.join(sessionDir(ctx.sessionId), `out-${newId()}.log`);
      fs.writeFileSync(f, full);
      return f;
    };
    if (input.background) {
      const log = path.join(sessionDir(ctx.sessionId), `bg-${newId()}.log`);
      const fd = fs.openSync(log, "a");
      const child = spawn("/bin/zsh", ["-lc", cmd], { cwd: ctx.cwd, detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      return { content: `Started in background (pid ${child.pid}). Log: ${log}` };
    }
    const timeout = Math.max(1, Number(input.timeout_sec ?? 600)) * 1000;
    return new Promise((resolve) => {
      const child = spawn("/bin/zsh", ["-lc", `${cmd}\n__rc=$?; printf '\\n${MARK}%s' "$PWD"; exit $__rc`], {
        cwd: ctx.cwd,
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" },
        // Own process group, so stop/timeout kills the whole pipeline, not just zsh.
        detached: true,
      });
      let out = "";
      const onData = (d: Buffer) => {
        const s = d.toString();
        out += s;
        const visible = s.split(MARK)[0];
        if (visible) ctx.onOutput(visible);
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
        const i = out.lastIndexOf(MARK);
        if (i >= 0) {
          const dir = out.slice(i + MARK.length).trim();
          if (dir && fs.existsSync(dir)) ctx.setCwd(dir);
          out = out.slice(0, i);
        }
        out = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
        resolve({ content: clip(`${out || "(no output)"}\n[exit ${code ?? "killed"} · cwd ${ctx.cwd}]`, 30_000, spill), isError: code !== 0 });
      });
    });
  },
};
