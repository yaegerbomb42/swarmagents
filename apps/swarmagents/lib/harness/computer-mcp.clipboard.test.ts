/**
 * computer-mcp clipboard plumbing (vm-image-desktop/computer-mcp/clipboard.mjs).
 *
 * xclip -i forks a background selection owner, so the spawned parent exits
 * but its stdio never closes. clipboard_set must settle on 'exit'.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  MAX_CLIPBOARD_READ_CHARS,
  capClipboardText,
  writeClipboard,
} from "../../vm-image-desktop/computer-mcp/clipboard.mjs";

/** A fake xclip: exits 0 right after stdin ends but never emits 'close'. */
function forkingXclip(record: { stdio?: unknown; written?: string }) {
  return (_cmd: string, _args: string[], options: Record<string, unknown>) => {
    record.stdio = options.stdio;
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: (text: string) => void; on: () => void };
      kill: () => void;
    };
    child.stdin = {
      on: () => {},
      end: (text: string) => {
        record.written = text;
        setTimeout(() => child.emit("exit", 0, null), 5);
        // No 'close': the forked selection owner keeps stdio open.
      },
    };
    child.kill = () => {};
    return child;
  };
}

test("writeClipboard resolves on exit even though stdio never closes", async () => {
  const record: { stdio?: unknown; written?: string } = {};
  const started = Date.now();
  const res = await writeClipboard({ spawnImpl: forkingXclip(record), text: "hello", timeoutMs: 2_000 });
  assert.deepEqual(res, { ok: true });
  assert.ok(Date.now() - started < 1_000, "must not wait for the timeout");
  assert.equal(record.written, "hello");
  assert.deepEqual(record.stdio, ["pipe", "ignore", "ignore"], "stdout/stderr are not piped into the fork");
});

test("writeClipboard reports a non-zero exit and a hung xclip", async () => {
  const failing = () => {
    const child = new EventEmitter() as EventEmitter & { stdin: { end: () => void; on: () => void }; kill: () => void };
    child.stdin = { on: () => {}, end: () => setTimeout(() => child.emit("exit", 1, null), 1) };
    child.kill = () => {};
    return child;
  };
  assert.deepEqual(await writeClipboard({ spawnImpl: failing, text: "x" }), { ok: false, error: "exit code 1" });
  const hung = () => {
    const child = new EventEmitter() as EventEmitter & { stdin: { end: () => void; on: () => void }; kill: () => void };
    child.stdin = { on: () => {}, end: () => {} };
    child.kill = () => {};
    return child;
  };
  assert.deepEqual(await writeClipboard({ spawnImpl: hung, text: "x", timeoutMs: 20 }), { ok: false, error: "timed out" });
});

test("capClipboardText caps what clipboard_get returns to the model", () => {
  assert.deepEqual(capClipboardText("abc"), { text: "abc", truncated: false, total: 3 });
  const big = "x".repeat(MAX_CLIPBOARD_READ_CHARS + 10);
  const capped = capClipboardText(big);
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.length, MAX_CLIPBOARD_READ_CHARS);
  assert.equal(capped.total, MAX_CLIPBOARD_READ_CHARS + 10);
});

const hasXclip = spawnSync("sh", ["-c", "command -v xclip && command -v Xvfb"]).status === 0;
test("writeClipboard against a real xclip on a virtual display", { skip: !hasXclip && "xclip/Xvfb not installed" }, async () => {
  const display = `:${90 + Math.floor(Math.random() * 9)}`;
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "320x240x24"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const env = { ...process.env, DISPLAY: display };
    const started = Date.now();
    const res = await writeClipboard({ spawnImpl: spawn, text: "swarm-clip", env, timeoutMs: 5_000 });
    assert.deepEqual(res, { ok: true });
    assert.ok(Date.now() - started < 2_000);
    const read = spawnSync("xclip", ["-o", "-selection", "clipboard"], { env, encoding: "utf8", timeout: 3_000 });
    assert.equal(read.stdout, "swarm-clip");
  } finally {
    // Killing the X server also ends the forked xclip selection owner.
    xvfb.kill("SIGKILL");
  }
});
