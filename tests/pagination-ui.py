# "Show earlier" in real Chrome: a seeded task with 250 archived + 20 live events pages in 100 at a time,
# keeps earlier pages when the stream sends a new snapshot, and never shows an event twice or skips one.
# Env: BASE (a local-mode server on SWARM_HOME), SWARM_HOME (seeded here, before the server reads it), OUT.
# Seed only: python3 tests/pagination-ui.py seed   ·   then run: python3 tests/pagination-ui.py
import json, os, sys, time
home = os.environ["SWARM_HOME"]
SID = "abcdef0123456789"
ARCH, LIVE = 250, 20
if len(sys.argv) > 1 and sys.argv[1] == "seed":
    d = os.path.join(home, "sessions", SID)
    os.makedirs(d, exist_ok=True)
    t0 = int(time.time() * 1000) - 3_600_000
    ev = lambda i: {"id": f"e{i:04d}", "ts": t0 + i * 1000, "type": "text", "text": f"event {i:04d}", "done": True}
    with open(os.path.join(d, "events-archive.jsonl"), "w") as f:
        for i in range(ARCH):
            f.write(json.dumps(ev(i)) + "\n")
    live = [{"id": "u0", "ts": t0, "type": "user", "text": "seeded long task"}] if False else []
    live += [ev(i) for i in range(ARCH, ARCH + LIVE)]
    json.dump(live, open(os.path.join(d, "events.json"), "w"))
    json.dump({"id": SID, "title": "Seeded long task", "createdAt": t0, "updatedAt": t0 + 999_000, "cwd": home, "archivedEvents": ARCH}, open(os.path.join(d, "meta.json"), "w"))
    json.dump([], open(os.path.join(d, "history.json"), "w"))
    print("seeded", d)
    sys.exit(0)

from playwright.sync_api import sync_playwright
base = os.environ["BASE"].rstrip("/"); out = os.environ.get("OUT", "/tmp")
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)
texts = lambda pg: pg.eval_on_selector_all(".col", "els => (els[0]?.textContent.match(/event \\d{4}/g) || [])")
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    for w, h, tag in [(1440, 900, "1440"), (375, 812, "375")]:
        ctx = b.new_context(viewport={"width": w, "height": h})
        ctx.add_init_script(f"localStorage.setItem('swarm.active', '{SID}')")
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        pg.goto(base + "/"); pg.wait_for_selector(".load-earlier", timeout=20000)
        check(f"{tag} button offers all {ARCH} archived events", f"Show {ARCH} earlier" in pg.inner_text(".load-earlier"), pg.inner_text(".load-earlier"))
        pg.wait_for_timeout(1500)
        check(f"{tag} button survives the live stream (was reset to 0 on every event)", pg.query_selector(".load-earlier") is not None)
        pg.evaluate("document.querySelector('.load-earlier').scrollIntoView()")
        pg.screenshot(path=f"{out}/{tag}-show-earlier-before.png")
        pg.click(".load-earlier"); pg.wait_for_selector(".load-earlier:has-text('Show 150')", timeout=10000)
        t = texts(pg)
        check(f"{tag} first page: 120 events, newest archived 100 prepended in order", t == [f"event {i:04d}" for i in range(150, 270)], f"{len(t)} {t[:1]}…{t[-1:]}")
        pg.click(".load-earlier"); pg.wait_for_selector(".load-earlier:has-text('Show 50')", timeout=10000)
        pg.click(".load-earlier"); pg.wait_for_function("!document.querySelector('.load-earlier')", timeout=10000)
        t = texts(pg)
        check(f"{tag} all {ARCH + LIVE} events, none twice, none missing, oldest first", t == [f"event {i:04d}" for i in range(ARCH + LIVE)], f"{len(t)} unique {len(set(t))}")
        pg.evaluate("document.querySelector('.scroll').scrollTop = 0")
        pg.screenshot(path=f"{out}/{tag}-show-earlier-after.png")
        check(f"{tag} no page errors", not errs, str(errs[:2]))
        ctx.close()
    b.close()
print(f"\n{sum(results)}/{len(results)} passed"); sys.exit(0 if all(results) else 1)
