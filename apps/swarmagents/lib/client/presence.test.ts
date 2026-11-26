import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BROWSER_VIEWPORT,
  clampFramebufferPoint,
  computerActionFromEvent,
  computerActionLabel,
  deriveComputerAction,
  derivePresence,
  DESKTOP_FRAMEBUFFER,
  lastLoopNudgeAt,
  parseComputerAction,
  pastTenseAction,
  presenceFromActivity,
  presenceLabel,
  presenceTone,
  sanitizeKeyCombo,
} from "./presence";
import type { RunStreamItem } from "./useRunStream";

/** One stream item, with the fields the reducer reads. */
function item(
  seq: number,
  kind: string,
  payload: Record<string, unknown> = {},
  ts = 1_000 + seq,
): RunStreamItem {
  return { seq, kind, data: payload, ts, runId: "run_test" } as unknown as RunStreamItem;
}

describe("derivePresence", () => {
  it("is idle with zero stats for an empty stream", () => {
    const presence = derivePresence([]);
    assert.equal(presence.runState, "idle");
    assert.equal(presence.action, undefined);
    assert.deepEqual(presence.stats, { toolCalls: 0, filesTouched: 0, seq: 0 });
    assert.equal(presenceLabel(presence), "Idle");
    assert.equal(presenceTone(presence), "muted");
  });

  it("names a running command and counts the tool call", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Bash", input: { command: "npm test" } }),
    ]);
    assert.equal(presence.runState, "working");
    assert.equal(presence.action, "Running npm test");
    assert.equal(presence.command, "npm test");
    assert.equal(presence.tool, "Bash");
    assert.equal(presence.stats.toolCalls, 1);
    assert.equal(presenceTone(presence), "accent");
  });

  it("marks the file a successful write touched", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Write", input: { file_path: "/workspace/hello.py" } }),
      item(3, "tool.result", { ok: true }),
    ]);
    assert.equal(presence.wroteFile, "/workspace/hello.py");
    assert.equal(presence.file, "/workspace/hello.py");
    assert.equal(presence.changedAt, 1_003);
    assert.equal(presence.stats.filesTouched, 1);
  });

  it("does not count a failed write as a change", () => {
    const presence = derivePresence([
      item(1, "tool.call", { name: "Write", input: { file_path: "/workspace/hello.py" } }),
      item(2, "tool.result", { ok: false }),
    ]);
    assert.equal(presence.wroteFile, undefined);
    assert.equal(presence.action, "Write failed");
  });

  it("keeps reads out of wroteFile", () => {
    const presence = derivePresence([
      item(1, "tool.call", { name: "Read", input: { file_path: "/workspace/README.md" } }),
      item(2, "tool.result", { ok: true }),
    ]);
    assert.equal(presence.wroteFile, undefined);
    assert.equal(presence.file, "/workspace/README.md");
    assert.equal(presence.action, "Reading /workspace/README.md");
  });

  it("waits on approvals and questions, then clears", () => {
    const waiting = derivePresence([
      item(1, "tool.call", { name: "Bash", input: { command: "rm -rf build" } }),
      item(2, "approval.required", {}),
    ]);
    assert.equal(waiting.runState, "waiting");
    assert.equal(waiting.action, "Waiting for your approval");

    const question = derivePresence([item(1, "question.required", {})]);
    assert.equal(question.runState, "waiting");
    assert.equal(question.action, "Waiting for your answer");

    const resolved = derivePresence([
      item(1, "question.required", {}),
      item(2, "question.resolved", {}),
      item(3, "run.started"),
    ]);
    assert.equal(resolved.runState, "working");
  });

  it("a new run resets a previous finished run", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Bash", input: { command: "uname -a" } }),
      item(3, "run.finished", {}),
      item(4, "run.created", {}),
    ]);
    assert.equal(presence.runState, "working");
  });

  it("a finished run says what it did, in the past tense", () => {
    const presence = derivePresence([
      item(1, "run.started"),
      item(2, "tool.call", { name: "Bash", input: { command: "python3 hello.py" } }),
      item(3, "run.finished", {}),
    ]);
    assert.equal(presence.runState, "done");
    assert.equal(presence.action, "Ran python3 hello.py");
    assert.equal(presenceLabel(presence), "Done");
    assert.equal(presenceTone(presence), "ok");
  });

  it("reports a failure with the message", () => {
    const presence = derivePresence([item(1, "run.error", { message: "Provider key rejected" })]);
    assert.equal(presence.runState, "failed");
    assert.equal(presence.action, "Provider key rejected");
    assert.equal(presenceTone(presence), "err");
  });

  it("reports a cancellation as done", () => {
    const stopped = derivePresence([
      item(1, "run.started"),
      item(2, "run.cancelled", {}),
    ]);
    assert.equal(stopped.runState, "done");
    assert.equal(stopped.action, "Stopped by you");
  });
});

describe("presenceFromActivity", () => {
  it("reads the newest polled activity line", () => {
    const working = presenceFromActivity([{ text: "Running npm test" }], "working");
    assert.equal(working.action, "Running npm test");
    assert.equal(working.command, "npm test");

    const writing = presenceFromActivity([{ text: "Editing hello.py" }], "working");
    assert.equal(writing.file, "hello.py");
    assert.equal(writing.wroteFile, "hello.py");
  });

  it("uses the past tense once the run is done", () => {
    const done = presenceFromActivity([{ text: "Running npm test" }], "done");
    assert.equal(done.action, "Ran npm test");
  });

  it("stays quiet when the line is not an action", () => {
    const presence = presenceFromActivity([{ text: "Waiting for your answer" }], "waiting");
    assert.equal(presence.action, undefined);
    assert.equal(presence.runState, "waiting");
  });
});

describe("pastTenseAction", () => {
  it("maps the verb and keeps the rest untouched", () => {
    assert.equal(pastTenseAction("Running python3 hello.py"), "Ran python3 hello.py");
    assert.equal(pastTenseAction("Editing /workspace/hello.py"), "Edited /workspace/hello.py");
    assert.equal(pastTenseAction("Read"), "Read");
    assert.equal(pastTenseAction("Grep “flask”"), "Grep “flask”");
  });
});

describe("clampFramebufferPoint", () => {
  it("clamps out-of-range coordinates onto the desktop framebuffer", () => {
    assert.deepEqual(clampFramebufferPoint(2000, -5, DESKTOP_FRAMEBUFFER), { x: 1599, y: 0 });
    assert.deepEqual(clampFramebufferPoint(640, 420, DESKTOP_FRAMEBUFFER), { x: 640, y: 420 });
    assert.deepEqual(clampFramebufferPoint(0, 0, DESKTOP_FRAMEBUFFER), { x: 0, y: 0 });
  });

  it("clamps onto the 1280x800 browser viewport too", () => {
    assert.deepEqual(clampFramebufferPoint(1400, 900, BROWSER_VIEWPORT), { x: 1279, y: 799 });
  });

  it("returns null when a coordinate is missing", () => {
    assert.equal(clampFramebufferPoint(undefined, 10, DESKTOP_FRAMEBUFFER), null);
    assert.equal(clampFramebufferPoint(10, undefined, DESKTOP_FRAMEBUFFER), null);
  });
});

describe("sanitizeKeyCombo", () => {
  it("keeps keysym names and modifiers, drops shell characters", () => {
    assert.equal(sanitizeKeyCombo("ctrl+l"), "ctrl+l");
    assert.equal(sanitizeKeyCombo("Return"), "Return");
    assert.equal(sanitizeKeyCombo("ctrl+alt+Delete"), "ctrl+alt+Delete");
    assert.equal(sanitizeKeyCombo("a; rm -rf /"), "arm-rf");
    assert.equal(sanitizeKeyCombo(""), "");
  });
});

describe("parseComputerAction", () => {
  const at = 1_700_000_000_000;

  it("parses computer-mcp clicks with clamped coordinates", () => {
    const action = parseComputerAction("mcp__computer-mcp__click", { x: 640, y: 420 }, at);
    assert.deepEqual(action, {
      kind: "click",
      x: 640,
      y: 420,
      at,
      framebuffer: DESKTOP_FRAMEBUFFER,
    });
    assert.equal(computerActionLabel(action!), "Clicking (640, 420)");
  });

  it("coerces string coordinates and clamps off-screen clicks", () => {
    const action = parseComputerAction(
      "mcp__computer-mcp__double_click",
      { x: "2000", y: "900" },
      at,
    );
    assert.equal(action?.kind, "double_click");
    assert.equal(action?.x, 1599);
    assert.equal(action?.y, 899);
    assert.equal(computerActionLabel(action!), "Double-clicking (1599, 899)");
  });

  it("names right- and middle-clicks from the button", () => {
    const right = parseComputerAction("mcp__computer-mcp__click", { x: 10, y: 10, button: 3 }, at);
    assert.equal(right?.detail, "Right-click");
    assert.equal(computerActionLabel(right!), "Right-clicking (10, 10)");
    const middle = parseComputerAction("mcp__computer-mcp__click", { x: 10, y: 10, button: 2 }, at);
    assert.equal(computerActionLabel(middle!), "Middle-clicking (10, 10)");
  });

  it("parses move, type, key, scroll and screenshot", () => {
    const move = parseComputerAction("mcp__computer-mcp__move", { x: 100, y: 200 }, at);
    assert.equal(move?.kind, "move");
    assert.equal(computerActionLabel(move!), "Moving to (100, 200)");

    const type = parseComputerAction("mcp__computer-mcp__type", { text: "hunter2-secret" }, at);
    assert.equal(type?.kind, "type");
    assert.equal(type?.x, undefined);
    assert.equal(type?.detail, "(14 chars)");
    assert.ok(!JSON.stringify(type).includes("hunter2"), "typed content is never carried");
    assert.equal(computerActionLabel(type!), "Typing (14 chars)");

    const key = parseComputerAction("mcp__computer-mcp__key", { combo: "ctrl+l" }, at);
    assert.equal(key?.kind, "keypress");
    assert.equal(key?.detail, "ctrl+l");
    assert.equal(computerActionLabel(key!), "Pressing ctrl+l");

    const scroll = parseComputerAction("mcp__computer-mcp__scroll", { dx: 0, dy: 3 }, at);
    assert.equal(scroll?.kind, "scroll");
    assert.equal(scroll?.detail, "down");
    assert.equal(computerActionLabel(scroll!), "Scrolling down");

    const shot = parseComputerAction("mcp__computer-mcp__screenshot", {}, at);
    assert.equal(shot?.kind, "screenshot");
    assert.equal(computerActionLabel(shot!), "Taking a screenshot");
  });

  it("keeps a click without usable coordinates, point-less", () => {
    const action = parseComputerAction("mcp__computer-mcp__click", { x: "nope", y: null }, at);
    assert.equal(action?.kind, "click");
    assert.equal(action?.x, undefined);
    assert.equal(computerActionLabel(action!), "Clicking");
  });

  it("parses Playwright MCP actions, including navigate hosts", () => {
    const nav = parseComputerAction(
      "mcp__playwright-mcp__browser_navigate",
      { url: "https://example.com/docs/page" },
      at,
    );
    assert.equal(nav?.kind, "navigate");
    assert.equal(nav?.detail, "example.com");
    assert.equal(computerActionLabel(nav!), "Opening example.com");

    const click = parseComputerAction(
      "mcp__browser-mcp__browser_click",
      { element: "Submit button" },
      at,
    );
    assert.equal(click?.kind, "click");
    assert.equal(click?.detail, "Submit button");
    assert.equal(computerActionLabel(click!), "Clicking Submit button");

    const type = parseComputerAction("mcp__playwright-mcp__browser_type", { text: "hello" }, at);
    assert.equal(type?.kind, "type");
    assert.equal(type?.detail, "(5 chars)");

    const key = parseComputerAction("mcp__playwright-mcp__browser_press_key", { key: "Enter" }, at);
    assert.equal(key?.kind, "keypress");
    assert.equal(key?.detail, "Enter");

    const wheel = parseComputerAction(
      "mcp__playwright-mcp__browser_mouse_wheel",
      { deltaY: -120 },
      at,
    );
    assert.equal(wheel?.kind, "scroll");
    assert.equal(wheel?.detail, "up");

    const hover = parseComputerAction(
      "mcp__playwright-mcp__browser_hover",
      { element: "nav link" },
      at,
    );
    assert.equal(hover?.kind, "move");
    assert.equal(hover?.detail, "nav link");

    const shot = parseComputerAction("mcp__playwright-mcp__browser_snapshot", {}, at);
    assert.equal(shot?.kind, "screenshot");
  });

  it("accepts bare tool names", () => {
    assert.equal(parseComputerAction("click", { x: 1, y: 2 }, at)?.kind, "click");
    assert.equal(parseComputerAction("browser_navigate", { url: "http://localhost:5173" }, at)?.kind, "navigate");
  });

  it("returns null for non-computer-use calls and out-of-scope tools", () => {
    assert.equal(parseComputerAction("Bash", { command: "npm test" }, at), null);
    assert.equal(parseComputerAction("Read", { file_path: "/workspace/a.py" }, at), null);
    assert.equal(parseComputerAction("mcp__computer-mcp__open_app", { name: "browser" }, at), null);
    assert.equal(parseComputerAction("mcp__computer-mcp__wait", { ms: 500 }, at), null);
    assert.equal(parseComputerAction("mcp__computer-mcp__drag", { x1: 1, y1: 2, x2: 3, y2: 4 }, at), null);
    assert.equal(parseComputerAction("mcp__playwright-mcp__browser_close", {}, at), null);
    assert.equal(parseComputerAction("", {}, at), null);
  });
});

describe("computerActionFromEvent", () => {
  const at = 1_700_000_000_000;

  it("infers the kind from the telemetry summary and keeps structured coords", () => {
    const click = computerActionFromEvent(
      { action: "Double-clicking at (640, 420)", x: 640, y: 420 },
      at,
    );
    assert.equal(click?.kind, "double_click");
    assert.equal(click?.x, 640);
    assert.equal(click?.y, 420);

    const type = computerActionFromEvent({ action: "Typing (12 chars)" }, at);
    assert.equal(type?.kind, "type");
    assert.equal(type?.detail, "(12 chars)");

    const key = computerActionFromEvent({ action: "Pressing ctrl+l", text: "ctrl+l" }, at);
    assert.equal(key?.kind, "keypress");
    assert.equal(key?.detail, "ctrl+l");

    const nav = computerActionFromEvent(
      { action: "Opening example.com", url: "https://example.com/x" },
      at,
    );
    assert.equal(nav?.kind, "navigate");
    assert.equal(nav?.detail, "example.com");

    const shot = computerActionFromEvent({ action: "Taking a screenshot" }, at);
    assert.equal(shot?.kind, "screenshot");

    const scroll = computerActionFromEvent({ action: "Scrolling down" }, at);
    assert.equal(scroll?.kind, "scroll");
    assert.equal(scroll?.detail, "down");
  });

  it("falls back to the URL when there is no summary", () => {
    const nav = computerActionFromEvent({ url: "https://example.com" }, at);
    assert.equal(nav?.kind, "navigate");
    assert.equal(nav?.detail, "example.com");
  });

  it("returns null for unknown summaries and empty payloads", () => {
    assert.equal(computerActionFromEvent({ action: "Something else entirely" }, at), null);
    assert.equal(computerActionFromEvent({}, at), null);
    assert.equal(computerActionFromEvent(null, at), null);
  });
});

describe("deriveComputerAction", () => {
  it("returns undefined for a stream with no computer-use action", () => {
    assert.equal(
      deriveComputerAction([item(1, "tool.call", { name: "Bash", input: { command: "ls" } })]),
      undefined,
    );
    assert.equal(deriveComputerAction([]), undefined);
  });

  it("takes the latest computer-use tool call", () => {
    const action = deriveComputerAction([
      item(1, "run.started"),
      item(2, "tool.call", { name: "mcp__computer-mcp__move", input: { x: 10, y: 20 } }),
      item(3, "tool.call", { name: "Bash", input: { command: "ls" } }),
      item(4, "tool.call", { name: "mcp__computer-mcp__click", input: { x: 640, y: 420 } }),
    ]);
    assert.equal(action?.kind, "click");
    assert.equal(action?.x, 640);
    assert.equal(action?.y, 420);
    assert.equal(action?.at, 1_004);
  });

  it("also reads computer.action telemetry events", () => {
    const action = deriveComputerAction([
      item(1, "computer.action", { action: "Clicking at (100, 200)", x: 100, y: 200 }),
    ]);
    assert.equal(action?.kind, "click");
    assert.equal(action?.x, 100);
  });

  it("attaches the parsed effect from the paired tool result", () => {
    const action = deriveComputerAction([
      item(1, "tool.call", {
        id: "t1",
        name: "mcp__computer-mcp__click",
        input: { x: 640, y: 420 },
      }),
      item(2, "tool.result", {
        id: "t1",
        ok: true,
        output: 'effect: screen changed near (640, 420); focus moved to "Save As"',
      }),
    ]);
    assert.equal(action?.kind, "click");
    assert.deepEqual(action?.effect, { changed: true, focus: "Save As" });
  });

  it("attaches a no-change effect when the paired result reports one", () => {
    const action = deriveComputerAction([
      item(1, "tool.call", {
        id: "t1",
        name: "mcp__computer-mcp__type",
        input: { text: "hello" },
      }),
      item(2, "tool.result", {
        id: "t1",
        ok: true,
        output: "effect: NO visible change after 1.5s; focused window unchanged",
      }),
    ]);
    assert.equal(action?.kind, "type");
    assert.deepEqual(action?.effect, { changed: false, elapsedS: 1.5 });
  });

  it("does not attach an effect when the result carries none", () => {
    const action = deriveComputerAction([
      item(1, "tool.call", {
        id: "t1",
        name: "mcp__computer-mcp__click",
        input: { x: 640, y: 420 },
      }),
      item(2, "tool.result", { id: "t1", ok: true, output: "clicked" }),
    ]);
    assert.equal(action?.kind, "click");
    assert.equal(action?.effect, undefined);
  });

  it("ignores tool results without a matching computer-use call", () => {
    const action = deriveComputerAction([
      item(1, "tool.call", { id: "t1", name: "Bash", input: { command: "ls" } }),
      item(2, "tool.result", { id: "t1", ok: true, output: "effect: screen changed" }),
    ]);
    assert.equal(action, undefined);
  });
});

describe("lastLoopNudgeAt", () => {
  it("returns undefined for a stream without nudge events", () => {
    assert.equal(lastLoopNudgeAt([]), undefined);
    assert.equal(
      lastLoopNudgeAt([item(1, "watchdog.loop", { action: "escalate", tool: "click" }, 200)]),
      undefined,
      "escalation halts the run and is not a nudge",
    );
  });

  it("returns the newest nudge's timestamp, skipping escalated loops", () => {
    const items = [
      item(1, "watchdog.loop", { action: "nudge", tool: "mcp__computer__click" }, 100),
      item(2, "watchdog.loop", { action: "escalate", tool: "mcp__computer__click" }, 200),
      item(3, "watchdog.loop", { action: "nudge", tool: "mcp__computer__click" }, 300),
    ];
    assert.equal(lastLoopNudgeAt(items), 300);
  });
});
