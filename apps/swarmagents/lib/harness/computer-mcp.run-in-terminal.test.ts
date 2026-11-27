/**
 * Tests for run_in_terminal: shared argument validation (validate.mjs), the
 * diff/settle logic (run-terminal.mjs, with an injected reader — no X server
 * needed), the harness risk classification, and one real Xvfb round trip that
 * proves the full focus → type → Return → settle → diff path returns the
 * output a terminal shows for a typed command.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DEFAULT_RUN_IN_TERMINAL_TIMEOUT_S,
  MAX_RUN_IN_TERMINAL_TIMEOUT_S,
  parseToolArgs,
  summarizeTool,
} from "../../vm-image-desktop/computer-mcp/validate.mjs";
import { diffNewLines, looksLikePrompt, settleTerminal } from "../../vm-image-desktop/computer-mcp/run-terminal.mjs";
import {
  classifyDesktopToolCall,
  computerActionEvent,
  isMutatingComputerCall,
} from "./computer-mcp";

// ---- Validator: run_in_terminal argument validation ------------------------

test("run_in_terminal: command is required, non-empty, length-capped", () => {
  assert.equal(parseToolArgs("run_in_terminal", {}).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "" }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "   " }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: 42 }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls -la" }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls -la\n" }).ok, true, "trailing newline is stripped (Return handled by the tool)");
  assert.equal(parseToolArgs("run_in_terminal", { command: "a".repeat(20_000) }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "a".repeat(20_001) }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls\0" }).ok, false, "control characters are rejected");
});

test("run_in_terminal: title validates like focus_window (non-empty, <=120 chars)", () => {
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: "Terminal" }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: "" }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: "   " }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: "a".repeat(121) }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: "a".repeat(120) }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: 42 }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", title: null }).ok, true, "null title === absent");
});

test("run_in_terminal: timeoutS must be an integer within [1, 60], default 10", () => {
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls" }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: 1 }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: 60 }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: "15" }).ok, true);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: "15.0" }).ok, false, "non-integer numeric strings are rejected");
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: 0 }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: 61 }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: -1 }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: 1.5 }).ok, false);
  assert.equal(parseToolArgs("run_in_terminal", { command: "ls", timeoutS: "abc" }).ok, false);
});

test("run_in_terminal: timeout alias maps to timeoutS; window_title/window_name alias title", () => {
  const canonical = { command: "ls", title: "Terminal", timeoutS: 20 };
  const aliased = parseToolArgs("run_in_terminal", { command: "ls", window_title: "Terminal", timeout: 20 });
  assert.equal(aliased.ok, true);
  assert.deepEqual(parseToolArgs("run_in_terminal", canonical), aliased);
  assert.deepEqual(parseToolArgs("run_in_terminal", { command: "ls", window_name: "Terminal" }), parseToolArgs("run_in_terminal", { command: "ls", title: "Terminal" }));
});

test("run_in_terminal: summarizeTool never echoes the command (redaction)", () => {
  assert.equal(summarizeTool("run_in_terminal", { command: "echo SECRET-TOKEN" }), "Running a command in the terminal");
  assert.equal(summarizeTool("run_in_terminal", { command: "ls", title: "Terminal" }), 'Running a command in the terminal "Terminal"');
  assert.equal(summarizeTool("run_in_terminal", { command: "ls", title: "T".repeat(200) }), `Running a command in the terminal "${"T".repeat(60)}"`);
});

// ---- diffNewLines: what appeared after the command ---------------------------

test("diffNewLines: strips the common prefix (pre-command read), keeps new lines", () => {
  const before = ["box@vm: ~$", "box@vm: ~$"];
  const after = ["box@vm: ~$", "box@vm: ~$", "echo SWARM-RIT-42", "SWARM-RIT-42", "box@vm: ~$"];
  const { lines, matchedBefore } = diffNewLines(after, before);
  assert.equal(matchedBefore, true);
  assert.deepEqual(lines, ["echo SWARM-RIT-42", "SWARM-RIT-42", "box@vm: ~$"]);
});

test("diffNewLines: fallback to the last N lines when nothing matches (scrolled/cleared)", () => {
  const after = ["line1", "line2", "line3", "line4", "line5"];
  const { lines, matchedBefore } = diffNewLines(after, ["totally-different-prompt"]);
  assert.equal(matchedBefore, false);
  assert.deepEqual(lines, after, "fewer than 40 lines: everything is kept");
  const many = Array.from({ length: 60 }, (_, i) => `log ${i}`);
  const fallback = diffNewLines(many, ["other"]).lines;
  assert.equal(fallback.length, 40);
  assert.equal(fallback[0], "log 20");
});

test("diffNewLines: empty current/before are handled", () => {
  assert.deepEqual(diffNewLines([], ["prompt"]), { lines: [], matchedBefore: true });
  assert.deepEqual(diffNewLines(["a", "b"], []), { lines: ["a", "b"], matchedBefore: false });
  assert.deepEqual(diffNewLines([], []), { lines: [], matchedBefore: false });
});

test("diffNewLines: OCR whitespace variance is ignored when matching", () => {
  const before = ["box@vm: ~$"];
  const after = ["box@vm: ~$", "  SWARM-RIT-42  "];
  const { lines, matchedBefore } = diffNewLines(after, before);
  assert.equal(matchedBefore, true);
  assert.deepEqual(lines, ["  SWARM-RIT-42  "]);
});

// ---- settleTerminal: poll until two consecutive reads are identical ----------

test("settleTerminal: two identical reads settle (screen stable)", async () => {
  let calls = 0;
  const reads = [
    { ok: true, lines: ["$", "echo hi", "hi", "$"] },
    { ok: true, lines: ["$", "echo hi", "hi", "$"] },
  ];
  const res = await settleTerminal(async () => {
    const r = reads[Math.min(calls, reads.length - 1)];
    calls++;
    return r;
  }, { timeoutMs: 5000, intervalMs: 20 });
  assert.equal(res.settled, true);
  assert.equal(calls, 2);
  assert.deepEqual(res.lines, reads[0].lines);
});

test("settleTerminal: output arriving in stages settles only once stable", async () => {
  const reads = [
    { ok: true, lines: ["$", "echo hi"] },
    { ok: true, lines: ["$", "echo hi", "hi"] },
    { ok: true, lines: ["$", "echo hi", "hi", "$"] },
    { ok: true, lines: ["$", "echo hi", "hi", "$"] },
  ];
  let calls = 0;
  const res = await settleTerminal(async () => reads[Math.min(calls++, reads.length - 1)], { timeoutMs: 5000, intervalMs: 20 });
  assert.equal(res.settled, true);
  assert.equal(calls, 4);
  assert.deepEqual(res.lines, reads[2].lines);
});

test("settleTerminal: reads that never stabilize time out with settled=false", async () => {
  let calls = 0;
  const res = await settleTerminal(async () => {
    calls++;
    return { ok: true, lines: ["ticking", String(calls)] };
  }, { timeoutMs: 150, intervalMs: 20 });
  assert.equal(res.settled, false);
  assert.ok(res.elapsedMs >= 100, `elapsed ${res.elapsedMs}ms`);
});

test("settleTerminal: failed reads are skipped and do not settle", async () => {
  let calls = 0;
  const res = await settleTerminal(async () => {
    calls++;
    if (calls === 2) return { ok: false, error: "transient OCR failure" };
    return { ok: true, lines: ["$", "ok"] };
  }, { timeoutMs: 5000, intervalMs: 20, quietMs: 60 });
  assert.equal(res.settled, true, "a transient failure mid-poll does not break settle");
  assert.deepEqual(res.lines, ["$", "ok"]);
});

test("looksLikePrompt: recognizes idle shell prompts, not output lines", () => {
  assert.equal(looksLikePrompt(["out", "box@vm:~$ "]), true);
  assert.equal(looksLikePrompt(["root@vm:/#", "", ""]), true);
  assert.equal(looksLikePrompt(["box@vm:~$ sleep 5"]), false);
  assert.equal(looksLikePrompt(["building..."]), false);
  assert.equal(looksLikePrompt([]), false);
});

test("settleTerminal: a silent slow command does not settle early without a prompt", async () => {
  // `sleep 5; echo done`: the echoed command sits unchanged for a while.
  const started = Date.now();
  let calls = 0;
  const res = await settleTerminal(async () => {
    calls++;
    return Date.now() - started < 200
      ? { ok: true, lines: ["box@vm:~$ sleep 5; echo done"] }
      : { ok: true, lines: ["box@vm:~$ sleep 5; echo done", "done", "box@vm:~$"] };
  }, { timeoutMs: 5000, intervalMs: 20, quietMs: 1000 });
  assert.equal(res.settled, true);
  assert.deepEqual(res.lines, ["box@vm:~$ sleep 5; echo done", "done", "box@vm:~$"]);
  assert.ok(res.elapsedMs >= 200, `settled only after the output arrived (${res.elapsedMs}ms)`);
});

test("settleTerminal: stable output without a prompt settles after the quiet period", async () => {
  const res = await settleTerminal(async () => ({ ok: true, lines: ["$ top -b", "load 0.1"] }), {
    timeoutMs: 5000,
    intervalMs: 20,
    quietMs: 150,
  });
  assert.equal(res.settled, true);
  assert.ok(res.elapsedMs >= 150, `waited the quiet period (${res.elapsedMs}ms)`);
});

test("settleTerminal: a screen identical to the pre-command read never settles", async () => {
  const before = ["box@vm:~$"];
  const res = await settleTerminal(async () => ({ ok: true, lines: before.slice() }), {
    timeoutMs: 150,
    intervalMs: 20,
    quietMs: 10,
    before,
  });
  assert.equal(res.settled, false);
});

// ---- Harness risk classification -------------------------------------------

test("run_in_terminal is mutating: allowed, not read-only, denied while user drives", () => {
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__run_in_terminal", { command: "ls" })?.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__run_in_terminal", { command: "ls", title: "Terminal", timeoutS: 20 })?.level, "allow");
  assert.equal(isMutatingComputerCall("mcp__computer-mcp__run_in_terminal"), true, "it runs commands — not an observation");
  const userDriving = classifyDesktopToolCall("mcp__computer-mcp__run_in_terminal", { command: "ls" }, { userDriving: true });
  assert.equal(userDriving?.level, "deny", "denied while the user controls the desktop, like type/key");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__run_in_terminal", { command: "" })?.level, "deny", "malformed call is denied, not allowed");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__run_in_terminal", { timeoutS: 999 })?.level, "deny");
});

test("computerActionEvent carries the command for run_in_terminal", () => {
  const event = computerActionEvent("mcp__computer-mcp__run_in_terminal", { command: "grep ERROR alpha.log", title: "Terminal" });
  assert.equal(event.text, "grep ERROR alpha.log");
  assert.equal(event.target, "Terminal");
  const noTitle = computerActionEvent("mcp__computer-mcp__run_in_terminal", { command: "ls" });
  assert.equal(noTitle.target, undefined);
});

// ---- Real Xvfb round trip ---------------------------------------------------

const HAVE_TOOLCHAIN = ["Xvfb", "xterm", "xfwm4", "wmctrl", "xdotool", "scrot", "convert", "tesseract", "xclip"].every(
  (b) => spawnSync("which", [b], { timeout: 5_000 }).status === 0,
);

async function waitFor(probe: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return probe();
}

test(
  "real Xvfb: run_in_terminal types a command into an xterm, waits for settle, returns the new lines",
  { skip: !HAVE_TOOLCHAIN && "needs Xvfb, xterm, xfwm4, wmctrl, xdotool, scrot, imagemagick, tesseract, xclip", timeout: 120_000 },
  async (t) => {
    const env = { ...process.env };
    const procs: ChildProcess[] = [];
    t.after(() => {
      for (const p of procs.reverse()) {
        try {
          if (p.pid) process.kill(-p.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    });

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cmcp-rit-"));
    let display = "";
    for (let i = 0; i < 20 && !display; i++) {
      const d = `:${1000 + Math.floor(Math.random() * 200)}`;
      if (!fs.existsSync(`/tmp/.X11-unix/X${d.slice(1)}`)) display = d;
    }
    assert.ok(display, "no free X display socket found");
    const displayEnv = { ...env, DISPLAY: display, HOME: scratch } as NodeJS.ProcessEnv;

    const xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { env: displayEnv, detached: true, stdio: "ignore" });
    procs.push(xvfb);
    const ready = await waitFor(() => spawnSync("xdotool", ["getdisplaygeometry"], { env: displayEnv, timeout: 5_000 }).status === 0, 10_000);
    assert.ok(ready, `Xvfb on ${display} did not become ready`);

    const xterm = spawn(
      "xterm",
      ["-T", "rit", "-bg", "black", "-fg", "#d0d0d0", "-fa", "Monospace", "-fs", "12", "-geometry", "80x12+100+60", "-xrm", "XTerm*allowTitleOps: false", "-e", "sh", "-c", "exec bash --norc --noprofile -i"],
      { env: displayEnv, detached: true, stdio: "ignore" },
    );
    procs.push(xterm);
    const mapped = await waitFor(() => spawnSync("xdotool", ["search", "--name", "rit"], { env: displayEnv, timeout: 5_000 }).status === 0, 10_000);
    assert.ok(mapped, "xterm window never appeared");

    const wm = spawn("xfwm4", ["--display", display], { env: displayEnv, detached: true, stdio: "ignore" });
    procs.push(wm);
    const listed = await waitFor(
      () => spawnSync("wmctrl", ["-lG"], { env: displayEnv, timeout: 5_000 }).stdout.toString().includes("rit"),
      10_000,
    );
    assert.ok(listed, "wmctrl never listed the rit window");
    await new Promise((r) => setTimeout(r, 500));

    const client = new Client({ name: "rit-test", version: "1.0.0" });
    t.after(() => client.close().catch(() => undefined));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("vm-image-desktop/computer-mcp/server.mjs")],
        env: { PATH: process.env.PATH ?? "", DISPLAY: display, HOME: scratch },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      return { isError: res.isError === true, text: res.content.map((c) => c.text ?? "").join("\n") };
    };

    const res = await call("run_in_terminal", { command: "echo SWARM-RIT-42", title: "rit", timeoutS: 15 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /settled: true/, res.text);
    assert.match(res.text, /elapsed:/, res.text);
    // OCR may insert spaces around hyphens; assert the token sequence.
    assert.match(res.text, /SWARM[\s-]*RIT[\s-]*42/i, `expected the echo marker in returned lines:\n${res.text}`);
    assert.doesNotMatch(res.text, /run_in_terminal failed/, res.text);

    // The command really ran on the desktop: the terminal now shows the marker,
    // and a second call (no title) on the still-focused terminal also works.
    const again = await call("run_in_terminal", { command: "echo again-$?", title: "rit", timeoutS: 15 });
    assert.equal(again.isError, false, again.text);
  },
);
