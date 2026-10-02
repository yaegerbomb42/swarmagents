# Sign-up, sign-in and the first-run welcome card in real Chrome, at 1440px and 375px, against a server-mode build.
# Env: BASE (e.g. http://127.0.0.1:3898; localhost is swapped to 127.0.0.1 by the app), OUT (screenshot dir), ADMIN_EMAIL + ADMIN_PW_FILE (a throwaway admin).
# Needs SWARM_SIGNUP=open. Exits non-zero if any check fails. Run: python3 tests/login-page.py
import json, os, re, secrets, sys, urllib.error, urllib.request
from playwright.sync_api import sync_playwright

base = os.environ["BASE"].rstrip("/")
out = os.environ.get("OUT", "/tmp/login-shots")
os.makedirs(out, exist_ok=True)
admin_email = os.environ.get("ADMIN_EMAIL")
admin_pw = open(os.environ["ADMIN_PW_FILE"]).read().strip() if os.environ.get("ADMIN_PW_FILE") else None
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def post(path, body, xff=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **({"X-Forwarded-For": xff} if xff else {})}, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


STRONG = "Dana-pass-2026!"
# In-page fetch, so the browser's own (Secure, HttpOnly) session cookie is used.
jget = lambda pg, path: pg.evaluate("p => fetch(p).then(r => r.json())", path)
signout = lambda pg: pg.evaluate("() => fetch('/api/login', { method: 'DELETE' }).then(r => r.status)")
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)  # the installed Google Chrome, not bundled Chromium
    print("chrome", browser.version)
    for width, height, tag in [(1440, 900, "1440"), (375, 812, "375")]:
        # FORWARDED_HOST: for a bare local `next start -H 127.0.0.1`, whose middleware redirects name the host "localhost"
        # (which the app then swaps back to 127.0.0.1). Behind nginx/Docker this isn't needed.
        extra = {"X-Forwarded-Host": os.environ["FORWARDED_HOST"]} if os.environ.get("FORWARDED_HOST") else {}
        ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=2 if width < 500 else 1, extra_http_headers=extra)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
        bad = []
        pg.on("response", lambda r: r.status >= 400 and bad.append(f"{r.status} {r.url.replace(base, '')}"))
        shot = lambda name: pg.screenshot(path=f"{out}/{tag}-{name}.png", full_page=True)
        user = f"dana{tag}{secrets.token_hex(2)}"

        # Signed out, any page sends you to /login and remembers where you were going.
        pg.goto(base + "/?from=next-check")
        pg.wait_for_selector(".login-form")
        check(f"{tag} signed-out / redirects to /login?next=", "/login?next=" in pg.url, pg.url)
        pg.wait_for_timeout(1000)
        print(f"   {tag} 4xx/5xx while loading /login signed out: {bad or 'none'}")
        check(f"{tag} sign-in field says 'Username or email'", "Username or email" in pg.inner_text("label[for=username]"))
        pg.wait_for_timeout(300)
        shot("01-signin")

        # Sign-up: the checklist is the server's rule set, and submit stays off until every rule is met.
        pg.click(".login-tab:has-text('Create account')")
        pg.fill("#username", user)
        pg.fill("#password", "password12")
        unmet = [t.strip().split("\n")[0].split(" (")[0] for t in pg.locator(".password-rules li.unmet").all_inner_texts()]
        check(f"{tag} weak password shows unmet rules", unmet == ["An uppercase letter", "A symbol"], str(unmet))
        check(f"{tag} submit disabled for a weak password", pg.is_disabled(".login-submit"))
        st, body = post("/api/signup", {"username": user + "w", "password": "password12"})
        check(f"{tag} server rejects the same weak password", st == 400 and "uppercase" in body.get("error", ""), f"{st} {body}")
        shot("02-signup-weak")
        pg.fill("#password", STRONG)
        check(f"{tag} strong password meets all 5 rules", pg.locator(".password-rules li.met").count() == 5)
        # The ALTCHA human check solves itself in about a second; submit unlocks once it has.
        pg.wait_for_selector(".login-submit:enabled", timeout=30000)
        check(f"{tag} submit enabled once the rules and the human check pass", pg.is_enabled(".login-submit"))
        pg.click(".toggle-visibility")
        check(f"{tag} Show reveals the password", pg.get_attribute("#password", "type") == "text")
        shot("03-signup-strong")
        pg.click(".toggle-visibility")
        pg.click(".login-submit")
        pg.wait_for_url(re.compile(r"from=next-check"), timeout=20000)
        check(f"{tag} sign-up lands on ?next=", pg.url.endswith("/?from=next-check"), pg.url)

        # First run: no model yet, so the welcome card shows (not an empty Settings sheet).
        pg.wait_for_selector(".welcome", timeout=15000)
        check(f"{tag} welcome card for a new account", "Connect a model" in pg.inner_text(".welcome"))
        check(f"{tag} Settings not auto-opened", pg.query_selector(".st-modal") is None)
        links = {}
        for btn in pg.locator(".welcome-provider").all():
            btn.click()
            links[btn.inner_text()] = pg.get_attribute(".welcome-keylink", "href")
        check(f"{tag} 8 providers, each with an https key page", len(links) == 8 and all((h or "").startswith("https://") for h in links.values()), json.dumps(links))
        pg.click(".welcome-provider:has-text('OpenRouter')")
        shot("04-welcome")
        # An Anthropic-shaped key selects Anthropic and is tested live against the real provider (it's fake, so it fails).
        pg.fill("#welcome-key", "sk-ant-api03-" + "x" * 60)
        check(f"{tag} key prefix picks Anthropic", "Anthropic" in pg.inner_text(".welcome-provider.active"))
        pg.wait_for_selector(".welcome-test.err, .welcome-test.ok", timeout=30000)
        check(f"{tag} live test rejects a fake key", pg.query_selector(".welcome-test.err") is not None, pg.inner_text(".welcome-test"))
        check(f"{tag} Save is off until the test passes", pg.is_disabled(".welcome-actions .btn.primary"))
        shot("05-welcome-badkey")
        # Stand in for a valid key (no real key in tests): the test endpoint answers ok; saving is real.
        pg.route("**/api/connections/test", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "message": "Connected · 12 models"})))
        pg.fill("#welcome-key", "sk-ant-api03-" + "y" * 60)
        pg.wait_for_selector(".welcome-test.ok", timeout=10000)
        shot("06-welcome-keyok")
        pg.click(".welcome-actions .btn.primary")
        pg.wait_for_selector("text=Step 2 of 2", timeout=10000)
        conns = jget(pg, "/api/connections")["connections"]
        llm = [c for c in conns if c.get("type") == "llm"]
        check(f"{tag} key saved as an Anthropic connection, never echoed", len(llm) == 1 and llm[0].get("preset") == "anthropic" and "y" * 20 not in json.dumps(conns), json.dumps(llm)[:200])
        shot("07-welcome-step2")
        pg.click(".welcome-task.suggested")
        pg.wait_for_selector(".col", timeout=15000)
        pg.wait_for_timeout(1500)
        sess = jget(pg, "/api/sessions")["sessions"]
        check(f"{tag} suggested task starts a task", len(sess) == 1, str([s.get("title") for s in sess]))
        shot("08-first-task")

        # Sign out, a wrong password, then the right one, with ?next= kept.
        signout(pg)
        ctx.clear_cookies()
        pg.goto(base + "/login?next=%2F%3Fafter%3Dlogin")
        pg.wait_for_selector(".login-form")
        pg.fill("#username", user)
        pg.fill("#password", "Wrong-pass-123!")
        pg.click(".login-submit")
        pg.wait_for_selector(".login-form .error", timeout=10000)
        check(f"{tag} wrong password message", "Wrong username, email or password" in pg.inner_text(".login-form .error"), pg.inner_text(".login-form .error"))
        shot("09-wrong-password")
        pg.fill("#password", STRONG)
        pg.click(".login-submit")
        pg.wait_for_url(re.compile(r"after=login"), timeout=15000)
        check(f"{tag} sign-in by username lands on ?next=", pg.url.endswith("/?after=login"), pg.url)
        pg.wait_for_timeout(800)
        check(f"{tag} with a model, the regular start screen shows", pg.query_selector(".welcome") is None)

        # An open redirect is refused: next=//evil.example falls back to "/".
        pg.goto(base + "/login?next=%2F%2Fevil.example%2Fx")
        pg.wait_for_timeout(2500)
        check(f"{tag} ?next=//evil stays on this site", pg.url.startswith(base + "/") and "evil" not in pg.url.split("?")[0], pg.url)

        # Rate limit: 10 failures for one account (from other IPs) lock it; the form shows the server's message.
        signout(pg)
        ctx.clear_cookies()
        victim = f"locked{tag}"
        for i in range(10):
            post("/api/login", {"username": victim, "password": "Nope-nope-123!"}, xff=f"203.0.113.{i + 1}")
        pg.goto(base + "/login")
        pg.wait_for_selector(".login-form")
        pg.fill("#username", victim)
        pg.fill("#password", "Nope-nope-123!")
        pg.click(".login-submit")
        pg.wait_for_selector(".login-form .error", timeout=10000)
        check(f"{tag} rate-limit message shown", "Too many attempts" in pg.inner_text(".login-form .error"), pg.inner_text(".login-form .error"))
        shot("10-rate-limited")

        # Forgot password: honest copy, no alert().
        pg.click(".forgot-password")
        check(f"{tag} forgot password explains what to do", "admin" in pg.inner_text(".login-footer"))

        # The seeded admin signs in by email.
        if admin_email and admin_pw:
            pg.fill("#username", admin_email)
            pg.fill("#password", admin_pw)
            pg.click(".login-submit")
            pg.wait_for_url(re.compile(r"^" + re.escape(base) + r"/$"), timeout=15000)
            me = jget(pg, "/api/me")
            check(f"{tag} admin signs in with the email", (me.get("user") or {}).get("isAdmin") is True, json.dumps(me.get("user")))
        # Horizontal overflow at this width? (signed out, on both tabs)
        signout(pg)
        ctx.clear_cookies()
        pg.goto(base + "/login")
        pg.wait_for_selector(".login-form")
        pg.wait_for_timeout(1500)
        pg.click(".login-tab:has-text('Create account')")
        pg.wait_for_timeout(1500)
        shot("11-signup-empty")
        sw = pg.evaluate("document.documentElement.scrollWidth")
        check(f"{tag} no horizontal scroll on /login", sw <= width, f"scrollWidth {sw}")
        check(f"{tag} no page errors", not errors, str(errors[:3]))
        ctx.close()
    browser.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
