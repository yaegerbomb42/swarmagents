#!/usr/bin/env python3
"""Verify the file-change diff + undo UI is styled and functional in the current design.

Seeds a task with a `write_file` overwrite event (real checkpoint marker + before/after sections),
then asserts: the diff body has the design-system styling applied (not unstyled), the +N/-N counts
are right, the Undo button is present and wired to the real route.

  SWARM_HOME=/tmp/swarm-x PORT=3795 python3 tests/diff-ui.py
"""
import json
import os
import secrets
import time

HOME = os.environ.get("SWARM_HOME")
PORT = os.environ.get("PORT", "3777")
if not HOME:
    raise SystemExit("set SWARM_HOME")

sid = secrets.token_hex(8)
sdir = os.path.join(HOME, "sessions", sid)
os.makedirs(sdir, exist_ok=True)
now = int(time.time() * 1000)

TARGET = os.path.join(HOME, "diff-target.txt")
CP = "a1b2c3d4e5f6"
cdir = os.path.join(HOME, "checkpoints", sid)
os.makedirs(cdir, exist_ok=True)
with open(os.path.join(cdir, CP + ".bak"), "w") as f:
    f.write("ORIGINAL LINE\n")
with open(os.path.join(cdir, CP + ".bak.json"), "w") as f:
    json.dump({"path": TARGET, "at": now})

output = "\n".join(
    [
        f"Overwrote {TARGET} (3 lines)",
        f"[checkpoint {CP} path={TARGET}]",
        "--- before (first 4k)---",
        "ORIGINAL LINE",
        "+++ after (first 4k) +++",
        "CHANGED LINE",
        "added line two",
        "added line three",
    ]
)
events = [
    {"id": "u1", "ts": now, "type": "user", "text": "update the file"},
    {"id": "w1", "ts": now + 10, "type": "tool", "name": "write_file", "input": {"path": TARGET, "content": "CHANGED LINE\nadded line two\nadded line three\n"}, "status": "ok", "output": output, "endTs": now + 120},
]
json.dump({"id": sid, "title": "diff fixture", "createdAt": now, "updatedAt": now, "cwd": HOME}, open(os.path.join(sdir, "meta.json"), "w"))
json.dump(events, open(os.path.join(sdir, "events.json"), "w"))
json.dump([], open(os.path.join(sdir, "history.json"), "w"))
print("fixture session:", sid)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script(f"localStorage.setItem('swarm.active', {sid!r});")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
    pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded", timeout=30000)
    pg.wait_for_selector(".ev.tool", timeout=20_000)
    # The write card opens by default for errors/images; click it open if needed.
    if not pg.query_selector(".diff-body"):
        for h in pg.query_selector_all("button.head"):
            try:
                h.click(timeout=1000)
                break
            except Exception:
                pass
    pg.wait_for_selector(".diff-body", timeout=10_000)
    pg.wait_for_timeout(600)

    ui = pg.evaluate(
        """() => {
      const body = document.querySelector('.diff-body');
      const cs = getComputedStyle(body);
      const undo = document.querySelector('.undo');
      const ucs = undo ? getComputedStyle(undo) : null;
      return {
        styled: cs.borderTopWidth !== '0px' && cs.borderRadius !== '0px',
        borderWidth: cs.borderTopWidth,
        radius: cs.borderRadius,
        adds: document.querySelectorAll('.diff-body .add').length,
        dels: document.querySelectorAll('.diff-body .del').length,
        undoText: undo?.textContent ?? '',
        undoStyled: ucs ? ucs.borderTopWidth !== '0px' : false,
        undoHint: document.querySelector('.undo-hint')?.textContent ?? '',
        copyBtns: document.querySelectorAll('.copy-btn').length,
      };
    }"""
    )
    pg.screenshot(path="/tmp/diff-ui.png")
    b.close()
    print("rendered:", ui)
    print("console errors:", len(errors))
    for e in errors[:5]:
        print("  -", e)
    assert ui["styled"], f"diff body is unstyled (missing CSS): {ui}"
    assert ui["adds"] == 3, f"expected 3 added lines, got {ui['adds']}"
    assert ui["dels"] == 1, f"expected 1 removed line, got {ui['dels']}"
    assert "Undo this edit" in ui["undoText"], f"undo button missing: {ui['undoText']!r}"
    assert ui["undoStyled"], "undo button is unstyled"
    assert "diff-target.txt" in ui["undoHint"], f"undo hint should name the file: {ui['undoHint']!r}"
    assert ui["copyBtns"] >= 1, "copy buttons missing"
    assert not errors, "no console errors allowed"
    print("diff-ui: PASS")