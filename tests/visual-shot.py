#!/usr/bin/env python3
"""Screenshot the task view for a session (used by bin/visual-check)."""
import os
from playwright.sync_api import sync_playwright

port = os.environ.get("VIS_PORT", "3789")
sid = os.environ.get("VIS_SID", "")
url = f"http://127.0.0.1:{port}/"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    # The UI restores the active task from localStorage.
    ctx.add_init_script(f"localStorage.setItem('swarm.active', {sid!r});")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
    pg.on("console", lambda m: errors.append(f"{m.type}: {m.text[:200]}") if m.type == "error" else None)
    pg.goto(url, wait_until="domcontentloaded", timeout=30000)
    # An SSE stream stays open for the active task, so `networkidle` never fires; wait on the UI instead.
    pg.wait_for_selector(".ev.tool, .empty", timeout=20000)
    pg.wait_for_timeout(2500)
    pg.screenshot(path="/tmp/visual-light.png", full_page=True)
    # Expand every tool card so diffs/undo/preview chips are visible.
    for b_ in pg.query_selector_all("button.head"):
        try:
            b_.click(timeout=1000)
        except Exception:
            pass
    pg.wait_for_timeout(800)
    pg.screenshot(path="/tmp/visual-light.png", full_page=True)
    # What rendered?
    checks = {
        "tool_cards": len(pg.query_selector_all(".ev.tool")),
        "diff_blocks": len(pg.query_selector_all(".diff")),
        "undo_buttons": len(pg.query_selector_all(".undo")),
        "copy_buttons": len(pg.query_selector_all(".copy-btn")),
        "preview_chips": len(pg.query_selector_all(".fp-chip")),
    }
    print("rendered:", checks)
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
    ctx.add_init_script(f"localStorage.setItem('swarm.active', {sid!r});")
    pg2 = ctx.new_page()
    pg2.goto(url, wait_until="domcontentloaded", timeout=30000)
    pg2.wait_for_selector(".ev.tool, .empty", timeout=20000)
    pg2.wait_for_timeout(2000)
    for b_ in pg2.query_selector_all("button.head"):
        try:
            b_.click(timeout=1000)
        except Exception:
            pass
    pg2.screenshot(path="/tmp/visual-dark.png", full_page=True)
    print("console errors:", len(errors))
    for e in errors[:10]:
        print("  -", e)
    b.close()
