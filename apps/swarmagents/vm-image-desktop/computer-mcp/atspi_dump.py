#!/usr/bin/env python3
"""AT-SPI2 accessibility tree dump for the SwarmAgents computer-use MCP server.

Walks the desktop's accessibility tree (GTK, Qt, Electron/Chromium apps that
expose AT-SPI2) and prints ONE JSON object on stdout:

    {"ok": true, "apps": ["xfce4-panel", ...], "truncated": false,
     "nodes": [{"app": "...", "role": "push button", "name": "OK",
                "states": ["enabled", "focusable", "focused"],
                "x": 10, "y": 20, "w": 80, "h": 24, "depth": 5}, ...]}

or {"ok": false, "error": "..."} when AT-SPI2 is unavailable. It never reads
text *contents* (an entry's typed value, a password field) — only accessible
names, roles, states and on-screen extents — so typed secrets cannot leak.

Run as: python3 atspi_dump.py [--app SUBSTR] [--max N] [--max-walk N]
        [--max-depth N] [--deadline SECONDS]
Arguments are validated by validate.mjs before the server spawns this script;
they are re-checked here (defense in depth). No shell is involved.
"""

import argparse
import glob
import json
import os
import re
import stat
import sys
import time

# Roles a model can usefully act on (click, type into, toggle, select).
INTERACTIVE_ROLES = {
    "push button", "button", "toggle button", "check box", "radio button", "menu item",
    "check menu item", "radio menu item", "menu", "combo box", "entry",
    "password text", "text", "link", "list item", "page tab", "tree item",
    "table cell", "spin button", "slider", "scroll bar", "icon", "split button",
    "push button menu", "toggle", "switch", "date editor", "editbar",
}
# Structural roles worth listing only when they carry a name (window titles,
# dialog headings, labels next to inputs).
NAMED_ROLES = {
    "frame", "dialog", "alert", "window", "heading", "label", "static",
    "page tab list", "menu bar", "tool bar", "status bar", "document web",
    "document frame", "image", "notification",
}
# Unnamed widgets are noise (layout cells, separators) except inputs and
# scroll/slider controls, which are useful even without a label.
KEEP_UNNAMED = {
    "entry", "password text", "text", "combo box", "spin button", "slider",
    "scroll bar",
}
STATE_NAMES = (
    ("focused", "STATE_FOCUSED"),
    ("focusable", "STATE_FOCUSABLE"),
    ("enabled", "STATE_ENABLED"),
    ("checked", "STATE_CHECKED"),
    ("pressed", "STATE_PRESSED"),
    ("selected", "STATE_SELECTED"),
    ("expanded", "STATE_EXPANDED"),
    ("editable", "STATE_EDITABLE"),
    ("modal", "STATE_MODAL"),
    ("active", "STATE_ACTIVE"),
)
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]+")
MAX_NAME = 120


def clean(value):
    text = CTRL_RE.sub(" ", str(value or "")).strip()
    return text[:MAX_NAME]


def parse_args(argv):
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--app", default="")
    p.add_argument("--max", type=int, default=150)
    p.add_argument("--max-walk", type=int, default=4000)
    p.add_argument("--max-depth", type=int, default=40)
    p.add_argument("--deadline", type=float, default=6.0)
    a = p.parse_args(argv)
    a.max = min(max(a.max, 1), 400)
    a.max_walk = min(max(a.max_walk, 1), 20000)
    a.max_depth = min(max(a.max_depth, 1), 80)
    a.deadline = min(max(a.deadline, 0.5), 20.0)
    a.app = clean(a.app).lower()[:64]
    return a


def discover_bus():
    """Point libatspi at the session's accessibility bus when run outside it.

    computer-mcp runs via `docker exec`, outside the XFCE session's private
    D-Bus, so the org.a11y.Bus lookup fails. Older at-spi2-core also publish
    the address on the X root window (libatspi reads that itself); newer
    releases only create `$XDG_RUNTIME_DIR/at-spi/bus_<display>`. Look for
    that socket in the usual runtime dirs, accepting only sockets owned by
    this user.
    """
    if os.environ.get("AT_SPI_BUS_ADDRESS"):
        return
    m = re.match(r"^[^:]*:(\d+)", os.environ.get("DISPLAY", ""))
    names = (["bus_%s" % m.group(1)] if m else []) + ["bus"]
    uid = os.getuid()
    dirs = []
    for d in [os.environ.get("XDG_RUNTIME_DIR", ""), "/run/user/%d" % uid]:
        if d:
            dirs.append(d)
    dirs += sorted(glob.glob("/tmp/runtime-*")) + sorted(glob.glob("/tmp/xdg-runtime-*"))
    for d in dirs:
        for name in names:
            sock = os.path.join(d, "at-spi", name)
            try:
                st = os.stat(sock)
            except OSError:
                continue
            if stat.S_ISSOCK(st.st_mode) and st.st_uid == uid:
                os.environ["AT_SPI_BUS_ADDRESS"] = "unix:path=" + sock
                return


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main(argv):
    args = parse_args(argv)
    discover_bus()
    try:
        import pyatspi  # type: ignore
    except Exception as err:  # pragma: no cover - depends on the VM image
        emit({"ok": False, "error": "pyatspi unavailable: %s" % clean(err)})
        return 0

    try:
        # Per-call D-Bus timeouts so one hung app cannot stall the dump.
        pyatspi.setTimeout(800, 3000)
    except Exception:
        pass

    states = [(label, getattr(pyatspi, attr, None)) for label, attr in STATE_NAMES]
    started = time.monotonic()
    nodes = []
    apps = []
    walked = 0
    truncated = False

    try:
        desktop = pyatspi.Registry.getDesktop(0)
        app_list = [desktop.getChildAtIndex(i) for i in range(desktop.childCount)]
    except Exception as err:
        emit({"ok": False, "error": "AT-SPI2 registry unavailable: %s" % clean(err)})
        return 0

    for app in app_list:
        if app is None:
            continue
        try:
            app_name = clean(app.name) or "(unnamed)"
        except Exception:
            continue
        apps.append(app_name)
        if args.app and args.app not in app_name.lower():
            continue
        stack = [(app, 0)]
        while stack:
            if len(nodes) >= args.max or walked >= args.max_walk or time.monotonic() - started > args.deadline:
                truncated = True
                break
            acc, depth = stack.pop()
            walked += 1
            try:
                state_set = acc.getState()
                if depth > 0 and not (state_set.contains(pyatspi.STATE_SHOWING) and state_set.contains(pyatspi.STATE_VISIBLE)):
                    continue  # hidden subtree: skip it and its children
                role = clean(acc.getRoleName()).lower()
                name = clean(acc.name)
            except Exception:
                continue
            wanted = (role in INTERACTIVE_ROLES and (name or role in KEEP_UNNAMED)) or (name and role in NAMED_ROLES)
            if depth > 0 and wanted:
                try:
                    ext = acc.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                    x, y, w, h = int(ext.x), int(ext.y), int(ext.width), int(ext.height)
                except Exception:
                    x = y = w = h = -1
                if w > 0 and h > 0 and x > -10000 and y > -10000:
                    node_states = [label for label, st in states if st is not None and state_set.contains(st)]
                    nodes.append({
                        "app": app_name, "role": role, "name": name, "states": node_states,
                        "x": x, "y": y, "w": w, "h": h, "depth": depth,
                    })
            if depth >= args.max_depth:
                continue
            try:
                count = min(acc.childCount, 500)
            except Exception:
                count = 0
            # Push in reverse so children are visited in document order.
            for i in range(count - 1, -1, -1):
                try:
                    child = acc.getChildAtIndex(i)
                except Exception:
                    child = None
                if child is not None:
                    stack.append((child, depth + 1))
        if truncated:
            break

    emit({"ok": True, "apps": apps[:50], "truncated": truncated, "walked": walked, "nodes": nodes})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
