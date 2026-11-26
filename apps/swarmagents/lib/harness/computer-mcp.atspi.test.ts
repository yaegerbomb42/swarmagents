/**
 * [core-08] AT-SPI2 accessibility inspection for the desktop computer-mcp
 * server: inspect_ui argument validation (argv only, no shell), the parser
 * for atspi_dump.py output, filtering/formatting for text-only models, the
 * harness risk gate + summaries, and the python tree walker itself (run
 * against a fake `pyatspi` module so no desktop is needed).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMPUTER_TOOLS,
  filterUiNodes,
  formatUiNodes,
  parseAtspiDump,
  parseToolArgs,
  summarizeTool,
} from "../../vm-image-desktop/computer-mcp/validate.mjs";
import { classifyDesktopToolCall, describeDesktopAction } from "./computer-mcp";

const HELPER = path.resolve(__dirname, "../../vm-image-desktop/computer-mcp/atspi_dump.py");

const SAMPLE = JSON.stringify({
  ok: true,
  apps: ["xfce4-panel", "chromium"],
  truncated: false,
  nodes: [
    { app: "chromium", role: "push button", name: "Reload", states: ["enabled", "focusable"], x: 80, y: 40, w: 24, h: 24, depth: 6 },
    { app: "chromium", role: "entry", name: "Address and search bar", states: ["enabled", "focused", "editable"], x: 120, y: 36, w: 900, h: 32, depth: 6 },
    { app: "chromium", role: "check box", name: "Remember me", states: ["enabled", "checked", "bogus-state"], x: 300, y: 400, w: 20, h: 20 },
    { app: "chromium", role: "push button", name: "Sign in", states: ["focusable"], x: 300, y: 450, w: 100, h: 30 },
    { app: "chromium", role: "push button", name: "zero", states: ["enabled"], x: 10, y: 10, w: 0, h: 10 },
    { app: "chromium", role: "push button", name: "offscreen", states: ["enabled"], x: -500, y: -500, w: 20, h: 20 },
    { app: "evil", role: "label", name: "line1\u0000\nline2\u001b[31m", states: ["enabled"], x: 1, y: 1, w: 10, h: 10 },
    "not-an-object",
  ],
});

test("inspect_ui is an exposed computer tool and validates to argv (never a shell string)", () => {
  assert.ok(COMPUTER_TOOLS.includes("inspect_ui"));
  assert.deepEqual(parseToolArgs("inspect_ui", {}), { ok: true, cmds: [["--max", "120"]] });
  assert.deepEqual(parseToolArgs("inspect_ui", { app: "Chromium", maxItems: 20 }), {
    ok: true,
    cmds: [["--max", "20", "--app", "Chromium"]],
  });
  // Filters applied after the walk widen the walk so matches are not cut off.
  assert.deepEqual(parseToolArgs("inspect_ui", { query: "Sign in", maxItems: 5 }).cmds, [["--max", "400"]]);
  assert.deepEqual(parseToolArgs("inspect_ui", { maxItems: "300" }).cmds, [["--max", "300"]]);
});

test("inspect_ui rejects injection attempts and out-of-range values", () => {
  // Shell metacharacters, newlines, flag-looking values and overlong names.
  for (const app of ["$(rm -rf /)", "a;b", "`id`", "x|y", "a\nb", "--app", "-x", "x".repeat(65)]) {
    assert.equal(parseToolArgs("inspect_ui", { app }).ok, false, `app ${JSON.stringify(app)} must be rejected`);
  }
  assert.equal(parseToolArgs("inspect_ui", { query: "--max" }).ok, false);
  // Ordinary names with spaces/punctuation are fine and stay one argv element.
  assert.deepEqual(parseToolArgs("inspect_ui", { app: "Mozilla Firefox (2)" }).cmds, [["--max", "120", "--app", "Mozilla Firefox (2)"]]);
  assert.equal(parseToolArgs("inspect_ui", { query: "<script>" }).ok, false);
  assert.equal(parseToolArgs("inspect_ui", { role: 42 }).ok, false);
  assert.equal(parseToolArgs("inspect_ui", { maxItems: 0 }).ok, false);
  assert.equal(parseToolArgs("inspect_ui", { maxItems: 301 }).ok, false);
  assert.equal(parseToolArgs("inspect_ui", { maxItems: 1.5 }).ok, false);
});

test("parseAtspiDump keeps on-screen widgets with click centers and sanitized labels", () => {
  const dump = parseAtspiDump(`some warning on stdout\n${SAMPLE}\n`);
  assert.equal(dump.ok, true);
  assert.deepEqual(dump.apps, ["xfce4-panel", "chromium"]);
  assert.equal(dump.truncated, false);
  // zero-size, off-screen and non-object nodes are dropped.
  assert.equal(dump.nodes.length, 5);
  const reload = dump.nodes[0];
  assert.deepEqual(
    { role: reload.role, name: reload.name, cx: reload.cx, cy: reload.cy },
    { role: "push button", name: "Reload", cx: 92, cy: 52 },
  );
  // Unknown states are dropped; known ones survive.
  assert.deepEqual(dump.nodes[2].states, ["enabled", "checked"]);
  // Control characters / escape sequences never reach the model.
  assert.equal(dump.nodes[4].name, "line1 line2 [31m");
  assert.doesNotMatch(dump.nodes[4].name, /[\u0000-\u001f]/);
  // Every center is a coordinate click() accepts.
  for (const n of dump.nodes) assert.equal(parseToolArgs("click", { x: n.cx, y: n.cy }).ok, true);
});

test("parseAtspiDump reports helper errors and garbage without throwing", () => {
  assert.deepEqual(parseAtspiDump(""), {
    ok: false,
    error: "accessibility helper returned no JSON",
    apps: [],
    truncated: false,
    nodes: [],
  });
  assert.equal(parseAtspiDump("{not json").ok, false);
  const down = parseAtspiDump(JSON.stringify({ ok: false, error: "pyatspi unavailable: No module named 'pyatspi'" }));
  assert.equal(down.ok, false);
  assert.match(down.error ?? "", /pyatspi unavailable/);
  // maxItems caps the parsed list.
  assert.equal(parseAtspiDump(SAMPLE, 2).nodes.length, 2);
});

test("filterUiNodes narrows by name and role; formatUiNodes flags disabled widgets", () => {
  const { nodes } = parseAtspiDump(SAMPLE);
  assert.deepEqual(
    filterUiNodes(nodes, { query: "sign" }).map((n) => n.name),
    ["Sign in"],
  );
  assert.deepEqual(
    filterUiNodes(nodes, { role: "button" }).map((n) => n.name),
    ["Reload", "Sign in"],
  );
  assert.equal(filterUiNodes(nodes, { maxItems: 1 }).length, 1);
  const text = formatUiNodes(filterUiNodes(nodes, { role: "button" }));
  assert.equal(
    text,
    [
      '  [push button] "Reload" -> click(92, 52) [80,40 24x24] @chromium',
      '  [push button] "Sign in" (disabled) -> click(350, 465) [300,450 100x30] @chromium',
    ].join("\n"),
  );
  assert.match(formatUiNodes(filterUiNodes(nodes, { role: "entry" })), /\(focused, editable\)/);
  assert.match(formatUiNodes(filterUiNodes(nodes, { role: "check" })), /\(checked\)/);
});

test("harness gate allows valid inspect_ui calls, denies invalid ones, and summarizes them", () => {
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__inspect_ui", { query: "Save" })?.level, "allow");
  assert.equal(classifyDesktopToolCall("mcp__computer-mcp__inspect_ui", { app: "$(id)" })?.level, "deny");
  assert.equal(summarizeTool("inspect_ui", {}), "Inspecting UI elements");
  assert.equal(
    summarizeTool("inspect_ui", { app: "thunar", query: "Rename" }),
    'Inspecting UI elements in thunar matching "Rename"',
  );
  assert.match(describeDesktopAction("mcp__computer-mcp__inspect_ui", { query: "OK" }) ?? "", /Inspecting UI elements/);
});

// ---- The python tree walker, against a fake pyatspi -------------------------

const FAKE_PYATSPI = String.raw`
STATE_SHOWING, STATE_VISIBLE, STATE_FOCUSED, STATE_FOCUSABLE, STATE_ENABLED = range(5)
STATE_CHECKED, STATE_PRESSED, STATE_SELECTED, STATE_EXPANDED, STATE_EDITABLE = range(5, 10)
STATE_MODAL, STATE_ACTIVE = 10, 11
DESKTOP_COORDS = 0

def setTimeout(a, b):
    pass

class _States:
    def __init__(self, s):
        self.s = set(s)
    def contains(self, s):
        return s in self.s

class _Ext:
    def __init__(self, x, y, w, h):
        self.x, self.y, self.width, self.height = x, y, w, h

class _Comp:
    def __init__(self, ext):
        self.ext = ext
    def getExtents(self, coords):
        return _Ext(*self.ext)

class Acc:
    def __init__(self, role, name, states=(STATE_SHOWING, STATE_VISIBLE, STATE_ENABLED), ext=(0, 0, 10, 10), children=()):
        self.role, self.name, self.states, self.ext = role, name, states, ext
        self.children = list(children)
    @property
    def childCount(self):
        return len(self.children)
    def getChildAtIndex(self, i):
        return self.children[i]
    def getRoleName(self):
        return self.role
    def getState(self):
        return _States(self.states)
    def queryComponent(self):
        return _Comp(self.ext)

V = (STATE_SHOWING, STATE_VISIBLE)
_app = Acc("application", "gedit", children=[
    Acc("frame", "Untitled - gedit", ext=(0, 0, 800, 600), children=[
        Acc("push button", "Save", states=V + (STATE_ENABLED, STATE_FOCUSED), ext=(700, 10, 60, 30)),
        Acc("filler", "", ext=(0, 0, 800, 600), children=[
            Acc("password text", "Password", states=V + (STATE_ENABLED, STATE_EDITABLE), ext=(100, 200, 200, 24)),
        ]),
        Acc("push button", "Hidden", states=(STATE_ENABLED,), ext=(1, 1, 5, 5), children=[
            Acc("push button", "Inside hidden", ext=(1, 1, 5, 5)),
        ]),
    ]),
])
_other = Acc("application", "thunar", children=[Acc("push button", "Back", ext=(5, 5, 20, 20))])

class _Desktop(Acc):
    pass

class Registry:
    @staticmethod
    def getDesktop(i):
        return _Desktop("desktop frame", "main", children=[_app, _other])
`;

function havePython(): boolean {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

function runHelper(args: string[], withFake = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atspi-fake-"));
  try {
    if (withFake) fs.writeFileSync(path.join(dir, "pyatspi.py"), FAKE_PYATSPI);
    const r = spawnSync("python3", [HELPER, ...args], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: withFake ? dir : path.join(dir, "empty"), PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 20_000,
    });
    return r;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("atspi_dump.py walks visible widgets, skips hidden subtrees, honors --app and --max", { skip: !havePython() && "python3 not installed" }, () => {
  const r = runHelper([]);
  assert.equal(r.status, 0, r.stderr);
  const dump = parseAtspiDump(r.stdout);
  assert.equal(dump.ok, true);
  assert.deepEqual(dump.apps, ["gedit", "thunar"]);
  assert.deepEqual(
    dump.nodes.map((n) => `${n.app}:${n.role}:${n.name}`),
    ["gedit:frame:Untitled - gedit", "gedit:push button:Save", "gedit:password text:Password", "thunar:push button:Back"],
  );
  const save = dump.nodes[1];
  assert.deepEqual(save.states, ["focused", "enabled"]);
  assert.deepEqual({ cx: save.cx, cy: save.cy }, { cx: 730, cy: 25 });

  const onlyThunar = parseAtspiDump(runHelper(["--app", "thun"]).stdout);
  assert.deepEqual(onlyThunar.nodes.map((n) => n.name), ["Back"]);

  const capped = parseAtspiDump(runHelper(["--max", "1"]).stdout);
  assert.equal(capped.nodes.length, 1);
  assert.equal(capped.truncated, true);
});

test("atspi_dump.py reports a missing pyatspi as ok:false instead of crashing", { skip: !havePython() && "python3 not installed" }, () => {
  const r = runHelper([], false);
  // The VM ships python3-pyatspi; a dev box usually does not. Either way the
  // helper must print parseable JSON and exit 0.
  assert.equal(r.status, 0, r.stderr);
  const dump = parseAtspiDump(r.stdout);
  if (!dump.ok) assert.match(dump.error ?? "", /pyatspi unavailable/);
});
