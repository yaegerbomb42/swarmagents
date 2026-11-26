// Forgiving computer-mcp arguments (core-37). The live desktop eval showed
// cheap models losing tasks to argument-name slips (`key {"key":"Enter"}`,
// `focus_window {"window_name":…}`, `open_app {"app_name":…}`) and to typing a
// command without pressing Enter. These map to the canonical calls, in the
// shared validator (so the harness classifier agrees) and end-to-end through
// the real server's MCP schema layer on Xvfb.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { clearsTerminalLine, normalizeKeyCombo, normalizeToolArgs, parseToolArgs } from "../../vm-image-desktop/computer-mcp/validate.mjs";
import { classifyDesktopToolCall } from "./computer-mcp";

test("key: key/keys/keysym alias combo; Enter, Esc, Control map to X keysyms", () => {
  assert.deepEqual(parseToolArgs("key", { key: "Enter" }).cmds, [["key", "Return"]]);
  assert.deepEqual(parseToolArgs("key", { keys: ["Control", "l"] }).cmds, [["key", "ctrl+l"]]);
  assert.deepEqual(parseToolArgs("key", { keysym: "esc" }).cmds, [["key", "Escape"]]);
  assert.deepEqual(parseToolArgs("key", { combo: "ctrl + Enter" }).cmds, [["key", "ctrl+Return"]]);
  assert.deepEqual(parseToolArgs("key", { combo: "alt+Tab" }).cmds, [["key", "alt+Tab"]], "canonical input unchanged");
  assert.equal(normalizeKeyCombo("BackSpace"), "BackSpace");
  // Still validated after mapping: no shell characters sneak in.
  assert.equal(parseToolArgs("key", { key: "Return; rm -rf /" }).ok, false);
});

test("focus_window: window_title / window_name alias title", () => {
  assert.deepEqual(parseToolArgs("focus_window", { window_name: "beta" }), parseToolArgs("focus_window", { title: "beta" }));
  assert.deepEqual(parseToolArgs("focus_window", { window_title: "beta" }), parseToolArgs("focus_window", { title: "beta" }));
  assert.equal(parseToolArgs("focus_window", {}).ok, false);
});

test("open_app: app / app_name alias name, everyday names map, the allowlist still holds", () => {
  const terminal = parseToolArgs("open_app", { name: "terminal" });
  assert.deepEqual(parseToolArgs("open_app", { app_name: "terminal" }), terminal);
  assert.deepEqual(parseToolArgs("open_app", { app: "Terminal" }), terminal);
  assert.deepEqual(parseToolArgs("open_app", { name: "xterm" }), terminal);
  assert.deepEqual(parseToolArgs("open_app", { name: "chrome" }), parseToolArgs("open_app", { name: "browser" }));
  assert.equal(parseToolArgs("open_app", { name: "/bin/sh" }).ok, false);
  assert.equal(parseToolArgs("open_app", { app: "toString" }).ok, false);
});

test("type: submit presses Return after the text, in keys and paste mode; content aliases text", () => {
  assert.deepEqual(parseToolArgs("type", { text: "touch marker.txt", submit: true }).cmds, [
    ["type", "--delay", "15", "touch marker.txt"],
    ["key", "Return"],
  ]);
  const pasted = parseToolArgs("type", { text: "x".repeat(300), submit: true }).cmds;
  assert.deepEqual(pasted.at(-1), ["key", "Return"]);
  assert.deepEqual(parseToolArgs("type", { text: "ls\n", submit: true }).cmds, [["type", "--delay", "15", "ls"], ["key", "Return"]], "no double Return");
  assert.deepEqual(parseToolArgs("type", { content: "hi" }).cmds, [["type", "--delay", "15", "hi"]]);
  assert.deepEqual(parseToolArgs("type", { text: "hi" }).cmds, [["type", "--delay", "15", "hi"]], "no submit: no Enter");
});

test("click/move: Anthropic-style coordinate [x, y] works", () => {
  assert.deepEqual(parseToolArgs("click", { coordinate: [10, 20] }), parseToolArgs("click", { x: 10, y: 20 }));
  assert.deepEqual(parseToolArgs("move", { coordinate: ["5", "6"] }), parseToolArgs("move", { x: "5", y: "6" }));
});

test("clearsTerminalLine: Return / KP_Enter / ctrl+u / ctrl+c clear a pending prompt line, others do not", () => {
  for (const c of ["Return", "KP_Enter", "ctrl+Return", "ctrl+u", "ctrl+c"]) assert.equal(clearsTerminalLine(c), true, c);
  for (const c of ["Tab", "ctrl+l", "BackSpace", "a", "ctrl+shift+c", undefined]) assert.equal(clearsTerminalLine(c), false, String(c));
});

test("normalizeToolArgs is pure and idempotent", () => {
  const input = { key: "Enter" };
  const once = normalizeToolArgs("key", input);
  assert.deepEqual(input, { key: "Enter" }, "input untouched");
  assert.deepEqual(normalizeToolArgs("key", once), once);
});

test("the harness classifier allows alias calls instead of flagging them malformed", () => {
  for (const [tool, input] of [
    ["key", { key: "Enter" }],
    ["focus_window", { window_name: "beta" }],
    ["open_app", { app_name: "terminal" }],
    ["type", { text: "ls", submit: true }],
  ] as const) {
    const d = classifyDesktopToolCall(`mcp__computer-mcp__${tool}`, input);
    assert.equal(d?.level, "allow", `${tool}: ${d?.reason}`);
  }
});

const XBINS = ["Xvfb", "xdotool", "xterm"];
const missing = XBINS.filter((b) => spawnSync("which", [b], { stdio: "ignore" }).status !== 0);

test(
  "end to end on Xvfb: alias calls pass the server's MCP schema and act (focus by window_name, type+submit runs the command)",
  { skip: missing.length ? `needs ${missing.join(", ")}` : false, timeout: 60_000 },
  async (t) => {
    const n = 140 + Math.floor(Math.random() * 40);
    const display = `:${n}`;
    const dir = mkdtempSync(path.join(os.tmpdir(), "swarm-cmcp-alias-"));
    const procs: ChildProcess[] = [];
    let client: Client | undefined;
    // One teardown, in order: close the MCP client (reaps the server), stop the
    // X processes, then remove the scratch dir (best effort: xterm's shell may
    // still be flushing history as it dies).
    t.after(async () => {
      await client?.close().catch(() => undefined);
      for (const p of procs.reverse()) {
        try {
          if (p.pid) process.kill(-p.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* leave it for tmp cleanup */
      }
    });
    const env = { ...process.env, DISPLAY: display, HOME: dir };
    procs.push(spawn("Xvfb", [display, "-screen", "0", "1024x700x24", "-nolisten", "tcp"], { stdio: "ignore", detached: true }));
    const until = async (check: () => boolean, what: string) => {
      for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out: ${what}`);
    };
    await until(() => spawnSync("xdotool", ["getmouselocation"], { env, stdio: "ignore", timeout: 2_000 }).status === 0, "Xvfb");
    if (spawnSync("which", ["xfwm4"], { stdio: "ignore" }).status === 0) {
      procs.push(spawn("xfwm4", ["--compositor=off"], { env, stdio: "ignore", detached: true }));
    }
    for (const [title, geo] of [["alpha", "60x10+0+0"], ["beta", "60x10+400+300"]]) {
      procs.push(
        spawn("xterm", ["-T", title, "-xrm", "XTerm*allowTitleOps: false", "-geometry", geo, "-e", "bash", "--norc", "--noprofile", "-i"], {
          cwd: dir,
          env,
          stdio: "ignore",
          detached: true,
        }),
      );
      await until(() => spawnSync("xdotool", ["search", "--name", `^${title}$`], { env, stdio: "ignore", timeout: 2_000 }).status === 0, title);
    }
    await new Promise((r) => setTimeout(r, 600));

    client = new Client({ name: "alias-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("vm-image-desktop/computer-mcp/server.mjs")],
        env: { PATH: process.env.PATH ?? "", DISPLAY: display, HOME: dir },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      return { isError: res.isError === true, text: res.content.map((c) => c.text ?? "").join("\n") };
    };

    // `window` is not documented: it must survive the MCP schema layer too.
    const focus = await call("focus_window", { window: "beta" });
    assert.equal(focus.isError, false, focus.text);
    const unsent = await call("type", { text: "echo pending" });
    assert.match(unsent.text, /Enter NOT pressed/, "a type without Return says so");
    // A second type into the same terminal is refused once: the first line never ran.
    const refused = await call("type", { text: "echo more" });
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, /never ran/);
    await call("key", { key: "ctrl+u" });
    const typed = await call("type", { text: "touch from-beta.txt", submit: true });
    assert.equal(typed.isError, false, typed.text);
    assert.match(typed.text, /\+ Return/);
    await until(() => existsSync(path.join(dir, "from-beta.txt")), "the submitted command ran");
    const key = await call("key", { key: "Enter" });
    assert.equal(key.isError, false, key.text);
  },
);
