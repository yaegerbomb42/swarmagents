#!/usr/bin/env python3
"""Integration check for the Timeline -> BrowserView hook (components/Timeline.tsx).

Seeds a task with realistic `browser` tool events (the exact output shape lib/tools/browser.ts
observe() emits), then asserts the browser-window cards render: address bar, screenshot, the
download/dialog notes, and the failure line.

  SWARM_HOME=/tmp/swarm-x PORT=3795 python3 tests/browser-view.py

This is fixture-based on purpose: it pins the *rendering contract* (which is what the Timeline hook
owns) independently of whether a live Chrome is available in the current environment.
"""
import json
import os
import secrets
import time

HOME = os.environ.get("SWARM_HOME", "")
PORT = os.environ.get("PORT", "3777")
if not HOME:
    raise SystemExit("set SWARM_HOME to the server's home, e.g. SWARM_HOME=/tmp/swarm-cline-home")

sid = secrets.token_hex(8)
sdir = os.path.join(HOME, "sessions", sid)
os.makedirs(sdir, exist_ok=True)

now = int(time.time() * 1000)
SITE = f"http://127.0.0.1:{PORT}/site"

# 1x1 png so the screenshot element has real image data.
PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)

ok_output = "\n".join(
    [
        "Clicked.",
        "• Downloaded report.csv to downloads/report.csv",
        "• Dialog shown: \"Leave site?\" (accepted)",
        "Tab 1/1: Reports — " + SITE + "/",
        SITE + "/",
        "",
        "Interactive elements:",
        '[1] a "Home" -> /home',
        '[2] button "Download CSV"',
    ]
)
fail_output = "Failed: no element matched index 7 (the page changed since the last snapshot)"

events = [
    {"id": "u1", "ts": now, "type": "user", "text": "try the browser"},
    {"id": "t1", "ts": now + 10, "type": "tool", "name": "browser", "input": {"action": "goto", "url": SITE + "/"}, "status": "ok", "output": ok_output, "images": [{"mediaType": "image/png", "data": PNG}], "endTs": now + 500},
    {"id": "t2", "ts": now + 600, "type": "tool", "name": "browser", "input": {"action": "click", "index": 7}, "status": "error", "output": fail_output, "endTs": now + 700},
    {"id": "x1", "ts": now + 800, "type": "text", "text": "Browser done.", "done": True},
]

json.dump({"id": sid, "title": "browser-view fixture", "createdAt": now, "updatedAt": now, "cwd": os.path.expanduser("~")}, open(os.path.join(sdir, "meta.json"), "w"))
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
    pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded", timeout=60_000)
    # A cold dev-server compiles the page on first hit, so allow a generous window for the cards.
    pg.wait_for_selector(".tool, .bv", timeout=60_000)
    # A provider/connection prompt may overlay the app on a fresh SWARM_HOME; dismiss it.
    for _ in range(3):
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(300)
    pg.wait_for_selector(".bv", timeout=60_000)
    pg.wait_for_timeout(1200)
    pg.evaluate("() => document.querySelector('.bv')?.scrollIntoView({block: 'center'})")
    pg.wait_for_timeout(300)

    ui = pg.evaluate(
        """() => ({
        cards: document.querySelectorAll('.bv').length,
        shots: document.querySelectorAll('.bv-view img').length,
        url: document.querySelector('.bv-url')?.textContent ?? '',
        notes: [...document.querySelectorAll('.bv-notes li')].map(e => e.textContent).join(' | '),
        fail: document.querySelector('.bv-fail')?.textContent ?? '',
        // The browser card replaces raw input/output; those must not be dumped twice.
        rawInputs: [...document.querySelectorAll('.tool')].filter(t => t.textContent.includes('"action"')).length,
    })"""
    )
    pg.screenshot(path="/tmp/browser-view.png")
    b.close()
    print("rendered:", ui)
    print("console errors:", len(errors))
    for e in errors[:5]:
        print("  -", e)
    assert ui["cards"] >= 2, f"expected browser cards, got {ui['cards']}"
    assert ui["shots"] >= 1, "expected the screenshot in the card"
    assert "127.0.0.1" in ui["url"], f"address bar should show the URL, got {ui['url']!r}"
    assert "Downloaded report.csv" in ui["notes"], f"download note missing: {ui['notes']!r}"
    assert "Dialog" in ui["notes"], f"dialog note missing: {ui['notes']!r}"
    assert ui["fail"].startswith("Failed:"), f"failure line missing: {ui['fail']!r}"
    assert ui["rawInputs"] == 0, "raw browser JSON should be replaced by the card, not shown too"
    print("browser-view: PASS")