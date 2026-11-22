# FIX-50 — 10-minute live-box verification checklist (Cursor, on the VPS)

**Run this on the Oracle VPS after the overnight bundles are merged and deployed.**
Every check settles a SUSPECTED item from the bug hunt (`swarmagents-overnight-bug-hunt.md`) or a live-only item from a bundle. Report each check as **pass / fail + the observed value**. **Never put a secret value in the report** — env var names and set/unset only.

**Where things live:** app container = the SwarmAgents compose service. Host ports (canonical shape, fix-12): app `3400` → container `3777`; desktop proxy host-loopback `3778`; BYOC hub host-loopback `3779`. Public site: `https://swarmagents.codes`.

**Time budget:** Sections 1–2 ≈ 5 min (can run any time). Sections 3–5 ≈ 10 min (need the P0 bundles deployed: FIX-01/02/03 minimum).

---

## Section 1 — Pre-flight: deployed commit + env (spec step 1; settles B2/B3/B4/B11/B13)

### 1.1 Deployed commit
```bash
curl -s https://swarmagents.codes/api/health
```
**Expect:** JSON with `"ok":true` and a `commit` field. Record the commit SHA — it must match the main head you deployed (confirm the bundles you expect are in it; `git log --oneline -5` on the VPS checkout if unsure). If `ok` is false or the commit is older than the deploy, stop — the deploy didn't land; go to Section 6.

### 1.2 Env dump in the app container
```bash
docker exec <app-container> printenv | grep -E 'SWARM_(SERVER_MODE|PUBLIC_ORIGIN|VM_LLM|VM_APPROVAL|SESSION_SECRET|ALLOWED_HOSTS|COOKIE_SECURE|VM_DESKTOP|DESKTOP_FRAME_TAP|MAX_CONCURRENT_VMS|VM_MEMORY|HARNESS_TOKEN)'
```
**Report set/unset per var (never values, never the secret itself):**
- `SWARM_SERVER_MODE` — **must be set** (`1`). Unset = BYOK isolation is off (B3): host keys would serve signed-in users. FAIL → set it, recreate container.
- `SWARM_PUBLIC_ORIGIN` (or `SWARM_VM_APPROVAL_BASE_URL`) — **must be set** in server mode (B4 fail-closed gate). Unset = every run start refused.
- `SWARM_VM_LLM_BASE_URL` — set = gateway proxy path active. Unset is OK **only if** `SWARM_PUBLIC_ORIGIN` is set (the app derives the proxy URL from it). Both unset = direct-mode fallback → raw user keys enter VM env and OpenAI-wire providers (Inception) are unreachable (B2). FAIL → set one.
- `SWARM_SESSION_SECRET` — must be set, 32+ chars (boot guard enforces; if the app is up, it's set — just confirm presence).
- `SWARM_ALLOWED_HOSTS` — must be set and include `swarmagents.codes` (B11 deny-by-default). Unset/empty in server mode = site-wide 403 (and with fix-13-14, boot refuses).
- `SWARM_COOKIE_SECURE` — `0` only if the site is served over plain HTTP with no TLS in front. Site is HTTPS → must be unset or `1` (B10 login loop otherwise).
- `SWARM_VM_DESKTOP` — production decision is **ON** (`1`, fix-16). `0`/unset = desktop off; the Desktop tab will show the explicit "Desktop off" notice (fix-16 UI) — record which. (The same grep line also catches `SWARM_VM_DESKTOP_IMAGE` — record it if set; unset = default `swarm-vm:desktop`.)
- `SWARM_DESKTOP_FRAME_TAP` — **optional, strict `1` only** (frametap). `1` = keyframe capture (`GET /desktop/keyframes`), retained keyframes, handback frame refs, and `desktop.damage` telemetry are on; unset/anything else = tap off with zero overhead. Record the state — the frame-tap-dependent spot-checks in 4.2/5.4 only apply when it is `1`. Note the memory cost while on (~2× framebuffer + 32 MiB keyframe store per tapped session).
- `SWARM_MAX_CONCURRENT_VMS` — optional (fix-19). Unset = default cap **4** live VMs; `0` disables the cap. Record the value — on this 4–8-instance VPS, anything above 8 risks host OOM at the 4 GiB desktop ceiling.
- `SWARM_VM_MEMORY` — optional per-VM memory ceiling. Unset = driver default `2g`; the server template sets `4g` for desktop VMs. Record which — `2g` with desktop ON can OOM the desktop image under load.
- `SWARM_HARNESS_TOKEN` — **set/unset only, never the value.** Must be set for external `/api/mcp/swarm-board` writes (the app validates bearer tokens against it server-side). Unset = board writes from outside a browser session are refused. (Historical note: before compose-passthrough-completion, setting this in `.env` silently never reached the container — if it is set in `.env.v2` (1.4) but unset here, the deployed compose file lacks the pass-through; fix the compose file, recreate.)

### 1.3 Mail + signup vars
```bash
docker exec <app-container> printenv | grep -E 'SWARM_(SMTP_|MAIL_FROM|PASSWORD_RESET_TTL_MIN|ALLOW_SIGNUP|TURNSTILE_|EMAIL_VERIFY_TTL_HOURS)'
```
**Expect:**
- `SWARM_SMTP_HOST` + `SWARM_MAIL_FROM` — **must be set before sign-ups open** (fix-39 password reset + fix-44 verification both send mail; without them, reset/verification email silently cannot deliver in server mode — the endpoints stay oracle-free 200 by design, failures only log server-side). If unset: password-reset spot-check (5.1) will fail at the inbox step — set SMTP first or record as a known gap. (`SWARM_SMTP_PORT`/`SECURE`/`USER`/`PASS` ride the same `SMTP_` prefix — report set/unset per name, never values; `SWARM_SMTP_PASS` is a credential.)
- `SWARM_PASSWORD_RESET_TTL_MIN` — optional (fix-39). Unset = default **30** minutes. Record if set; the 5.1 spot-check's link-expiry expectation follows this value.
- `SWARM_EMAIL_VERIFY_TTL_HOURS` — optional (fix-44). Unset = default **24** hours. Record if set; the 5.2 verification-link expectation follows this value.
- `SWARM_ALLOW_SIGNUP` — record the posture (fix-42: closed by default; `1`/`true` = open sign-up, the supported launch posture; invite-only is not implemented). If `1`, the next two vars must also be set.
- `SWARM_TURNSTILE_SECRET` + `SWARM_TURNSTILE_SITE_KEY` — both set = bot check active on signup (fix-44, fails closed when configured). Both unset = skipped (fine while sign-up is closed). **Exactly one set = misconfiguration** — the widget renders without server verification or vice versa; fix before opening sign-up.

### 1.4 Compose env file + images + listening ports
```bash
grep -E 'SWARM_VM_DESKTOP|SWARM_VM_DRIVER|SWARM_ALLOWED_HOSTS|SWARM_TRUST_PROXY|SWARM_DESKTOP_FRAME_TAP|SWARM_PUBLIC_ORIGIN' .env.v2
docker images | grep swarm-vm
ss -ltnp | grep -E '3777|3778|3779|3400'
```
**Expect:**
- `SWARM_TRUST_PROXY` set (`1`) — the app sits behind nginx; without it, forwarded headers are ignored and the Origin check can 403 every POST (B12).
- **Cross-check `.env.v2` against the 1.2/1.3 container dumps:** a var set in `.env.v2` but unset in the container means the deployed compose file lacks its `${VAR}` pass-through (compose files enumerate env explicitly; there is no `env_file:`). The pass-throughs for every documented var landed in frametap-compose-passthrough + compose-passthrough-completion — a mismatch means the deployed compose file predates them. Fix the compose file and recreate; do not debug the app. (This is exactly how `SWARM_DESKTOP_FRAME_TAP` and `SWARM_HARNESS_TOKEN` used to silently drop.)
- `docker images` shows **both** `swarm-vm:claude` and `swarm-vm:desktop` (fix-16: `deploy.sh do_deploy` builds when missing — note deploy.sh is server-installed; if the desktop image is missing, the updated deploy.sh hasn't been copied to the VPS yet → run `./deploy.sh build-desktop`).
- `ss` shows the app on `3400` and loopback listeners on `3778` + `3779` (container publishes). `3778` missing = desktop proxy not reachable from host nginx (B9).

---

## Section 2 — Deploy verification (spec steps 2–4, 6, 8; settles B8/B9/B10/B12 + FIX-49)

### 2.1 nginx config + reload
```bash
nginx -t && systemctl reload nginx
```
**Expect:** `syntax is ok` / `test is successful`, reload succeeds. **Known blocker:** `/etc/nginx/sites-enabled/models.conf` historically had a bare `location /models/` that fails `nginx -t` — if `nginx -t` fails on that file, fix/remove the bare location first, then re-run. Do not force a reload with a failing test.

### 2.2 Vhost locations (spec step 4; settles B9/B12)
```bash
nginx -T | grep -E 'location|proxy_pass|X-Forwarded-Host'
```
**Expect in the active vhost:**
- `location /` → `127.0.0.1:3400` (NOT 3777 — that was the dead upstream).
- SSE regex location (`/api/runtime/stream/`, `/api/share/<token>/stream`) → `3400` with `proxy_buffering off`.
- `location /desktop/` → `127.0.0.1:3778` with Upgrade headers.
- `location /preview/` → 3400 HTTP / 3778 WS (the `$preview_backend` map).
- `location /byoc/` → `127.0.0.1:3779` with Upgrade headers.
- `proxy_set_header X-Forwarded-Host $host;` in **every** location (fix-12/fix-15).
Any missing location = the corresponding feature is dead on the live site even if the code is fixed. FAIL → install `deploy/nginx.conf` from the repo, `nginx -t`, reload.

### 2.3 Health + readiness (fix-16 + fix-38 gates)
```bash
curl -s https://swarmagents.codes/api/health
curl -s "https://swarmagents.codes/api/health?ready=1"
```
**Expect:**
- Liveness: `"ok":true`, and a `desktop` boolean present (fix-16 always reports it; `false` = desktop off on this deploy).
- Readiness: HTTP 200 with `"ready":true`. If 503, read the `reason`:
  - `DESKTOP_IMAGE_MISSING` → desktop is ON but `swarm-vm:desktop` isn't built. Fix: `./deploy.sh build-desktop`, re-check. (Deploy `verify_health` would have rolled back on this — if you're seeing it post-deploy, the image was deleted or never built.)
  - `DESKTOP_PROXY_LISTEN_FAILED` → desktop ON but the proxy isn't listening (port conflict or bad `SWARM_DESKTOP_PROXY_HOST`; fix-38). Check `ss -ltnp | grep 3778` and app logs for the bind error. In server mode + desktop on, a bind failure now **fails boot** — if the app is up but readiness says this, the proxy died after boot or a standalone proxy shape is in use.
  - Any other reason → record verbatim, go to Section 6.

### 2.4 Set-Cookie inspection (spec step 2; settles B8/B10)
```bash
curl -sI https://swarmagents.codes/login
```
Then do a real login in a browser (or with a cookie jar) and inspect the `Set-Cookie` on the login response:
```bash
curl -s -i -c /tmp/cj.txt -X POST https://swarmagents.codes/api/login \
  -H 'Content-Type: application/json' -H 'Origin: https://swarmagents.codes' \
  -d '{"email":"<operator-email>","password":"<operator-password>"}' | grep -i 'set-cookie'
```
**Expect:** `swarm_session=...` with `HttpOnly`, `SameSite=Lax`, and `Secure` present (site is HTTPS). The uid inside the token for a real user is `local_<email>` — the browser will send it `%40`-encoded; fix-03 (p0 bundle) URL-decodes it in the desktop proxy, which Section 4.2 proves end-to-end. If `Secure` is missing on an HTTPS site → cookie policy is weakened; if `Secure` is present but the site were HTTP → login loop (B10). Neither should happen here.

### 2.5 Origin check (spec step 3; settles B12)
The login POST in 2.4 already covers this (it sends `Origin: https://swarmagents.codes` through the TLS vhost). **Expect:** 200 (or 401 for wrong credentials — either proves the Origin gate passed). A **403** = the cross-site check is rejecting same-site POSTs behind the proxy (B12) → confirm `SWARM_TRUST_PROXY=1` (1.4) and `X-Forwarded-Host` in the vhost (2.2); fix-15's app-side change must be in the deployed commit.

### 2.6 SSE through the vhost (spec step 6)
With a run active (Section 3) or any known run id, using the cookie jar from 2.4:
```bash
curl -N -b /tmp/cj.txt https://swarmagents.codes/api/runtime/stream/<runId>
```
**Expect:** events stream incrementally (not one buffered burst at close). If nothing arrives until the connection ends → nginx buffering is on for this path → the SSE regex location (2.2) is missing or not matched.

### 2.7 Logo check (spec step 8; FIX-49)
```bash
curl -sI https://swarmagents.codes/brand/logo.png
```
**Expect:** `200`, an image `Content-Type` (`image/png`), and a plausible `Content-Length` (tens of KB+, not ~130 bytes — a tiny body is a Git LFS pointer file, meaning the deployed build never resolved LFS and the login page silently ships wordmark-only via its `onError` hide). Also open `https://swarmagents.codes/login` and confirm the logo renders. FAIL → fix the deploy to pull LFS (`git lfs pull` before build) or commit the resolved asset; keep the `onError` fallback.

### 2.8 Status page sanity
Open `https://swarmagents.codes/status`. **Expect:** Service row reads Operational (or "Degraded — storage unavailable" if storage is genuinely unwritable — fix-48 removed the internal "board" wording; any "board" text on this page = fix-48 not in the deployed commit). "Live desktop" row present (fix-16): On/Off matching `SWARM_VM_DESKTOP` from 1.2.

---

## Section 3 — First real run (the gate for "ready for live users")

No real agent run has ever completed on the deployed site. This sequence proves the whole critical path: sign in → add key → run → watch → complete. Use the operator account (BYOK: the key goes in **account Settings**, never host env).

### 3.1 Sign in
Open `https://swarmagents.codes`, sign in. **Expect:** lands in the app (no login loop back to `/login` — a loop = B10, check 1.2 `SWARM_COOKIE_SECURE` + 2.4).

### 3.2 Add the Inception key
Settings → Providers → add Inception with the operator's Inception API key. **Expect:** the model field defaults to **`mercury-3`** (fix-01/p0 bundle — if it says `mercury`, the p0 bundle is not deployed; every gateway call will fail). Use the provider test/probe if offered: **Expect** a successful probe (fix-01 also repaired already-saved configs carrying `mercury` via `repairLegacyModelIds` — a previously saved Inception config should now show `mercury-3` without re-saving).

### 3.3 First-run onboarding (fix-43, if deployed)
With a **fresh** account that has zero providers: sign in. **Expect:** auto-routed to Settings→providers once, hero shows "Add a provider key to run your first task", composer blocked with "Add a provider key to send". Sending a task must NOT be accepted-then-failed. (Skip if fix-43 isn't in the deployed commit; record as not-yet-deployed.)

### 3.4 Run a trivial task
Send a small task, e.g.: "Create a file named hello.txt containing the text hello world, then tell me what you did."
**Expect, in order:**
1. Run accepted (202 / appears in the UI as running — not an immediate config error). A 400 naming `SWARM_PUBLIC_ORIGIN` / `SWARM_VM_LLM_BASE_URL` = fix-10-11's fail-closed guard doing its job → the env from 1.2 is incomplete; fix env, retry. A 400 "Verify your email" = fix-44 gate on an unverified account → verify via the emailed link (5.2) or use a grandfathered account.
2. The VM provisions and the harness starts streaming events (SSE live — cross-check 2.6).
3. The desktop view (if desktop ON) connects and shows the VM screen — no "Desktop offline" after retries (that was B7/B8; Section 4.2 digs in if it fails).
4. The run completes with a final message; the file exists in the workspace (file browser or a follow-up "cat hello.txt" task).

### 3.5 Run report + token accounting
Open the completed run's report/trajectory. **Expect:** per-provider/model token usage recorded (token-efficiency-pack accounting; unknown pricing stays unknown rather than fabricated). If the TrajectoryView is deployed, it replaces the legacy Telemetry surface — confirm it renders the run's turns with filters/search working. (Desktop screen-change markers and keyframe thumbnails in the trajectory appear only when `SWARM_DESKTOP_FRAME_TAP=1` — see 1.2; their absence with the tap off is expected, not a failure.)

### 3.6 Sign out / sign back in
Sign out, sign back in. **Expect:** session cleared on sign-out (visiting `/` redirects to `/login`), fresh sign-in works, the completed run is still listed (persistence across sessions).

**Section 3 pass = the first real run ever on SwarmAgents.** Record the run id.

---

## Section 4 — Live captures (spec steps 5 + 7; settles M12/FIX-27 and M22/FIX-37)

### 4.1 Mercury-3 streaming tool-call chunk shape (FIX-27 verification)
FIX-27 hardened the stream translator against synthetic fixtures; this capture settles whether Mercury-3 actually emits those shapes. During a tool-using run (3.4 works — it forces tool calls), capture the raw upstream SSE. Easiest path: in the app container, temporarily enable gateway debug logging if present, or reproduce the call directly:

```bash
curl -s -N https://api.inceptionlabs.ai/v1/chat/completions \
  -H "Authorization: Bearer <operator-inception-key>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mercury-3","stream":true,"messages":[{"role":"user","content":"Use the echo tool with text hi."}],"tools":[{"type":"function","function":{"name":"echo","description":"Echo text","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}}],"tool_choice":"auto"}' \
  | tee /tmp/mercury3-stream-capture.txt
```
(Use the operator's key transiently in the shell only — do not write it into any report or file that persists. Delete `/tmp/mercury3-stream-capture.txt` after extracting the findings if it contains anything sensitive; it shouldn't — it's response data.)

**Record these four facts from the capture:**
1. For each tool-call `index`: does `id` and `name` arrive in the **first** chunk for that index, or later / as empty strings / omitted?
2. Is `index` present on **every** tool-call delta chunk, or omitted on continuations?
3. Is `name` ever **fragmented** across chunks (partial name in one chunk, rest in another)? — FIX-27 does NOT concatenate name fragments (first non-empty wins); if Mercury-3 fragments names, that's a follow-up fix.
4. Do multiple tool calls **interleave** (chunks for index 1 arriving before index 0 finishes)?

**Expect (pass):** the deployed translator handles whatever shape appears — i.e., the Section 3 run's tool calls executed correctly (no empty-id/empty-name `tool_use` blocks reaching the harness, which would surface as harness errors / stalled turns in the run log). Report the four facts either way; if the shape includes name fragmentation or nameless calls, flag for the FIX-27 follow-up noted in its APPLY.md.

### 4.2 Desktop dial + FIX-37 subprotocol check (spec step 5; settles B7/B8/M22)
FIX-37 is not a code bundle — it's this live dial. With a run's VM up (or any desktop session), open the desktop view in a browser with devtools → Network → the `/desktop/ws` WebSocket request.

**Check all four:**
1. **Upgrade succeeds:** status `101 Switching Protocols`. A 401 = cookie decode (B8) still broken → fix-03 not deployed. A 502 = proxy couldn't dial upstream (fix-30 now fails fast with 502 instead of hanging — a hang + eventual "Desktop offline" = fix-30 not deployed).
2. **`Sec-WebSocket-Protocol: binary` preserved both directions (FIX-37/M22):** the browser's request carries `Sec-WebSocket-Protocol: binary` (noVNC requires it) **and** the 101 response echoes `Sec-WebSocket-Protocol: binary`. Missing in the response = the proxy strips it → websockify framing breaks (binary frames misparsed). Record request + response header values verbatim.
3. **No handshake-timeout in app logs:** after the dial, `docker logs <app-container> --since 2m | grep desktop-proxy`. **Expect:** no `session … closed (handshake-timeout)` lines (that was B7's 15 s deadlock signature). Presence = fix-02 (rfb-handshake-fix) not deployed.
4. **Frames render:** the desktop paints and updates (mouse move / run activity produces visible change). Connected-but-black with a clean handshake → check the RFB version path (desktop image speaks 3.8; 3.3 unsupported, pre-existing).

**Frame-tap checks (only if `SWARM_DESKTOP_FRAME_TAP=1` in 1.2; skip and mark "tap off" otherwise):** with the desktop session live and the screen changing, `curl -b /tmp/cj.txt https://swarmagents.codes/desktop/keyframes` → **Expect:** a session-gated JSON list of captured keyframes (ids + timestamps), growing as the screen changes; fetching one by id returns a JPEG. Empty list after visible screen changes = the tap isn't capturing (check the deployed commit carries frametap-keyframes + frametap-deployed-wiring, and that the var reached the container — 1.4 cross-check). Also confirm `desktop.damage` events appear in the run's stream/trajectory during desktop activity (desktop-damage-telemetry; coalesced ~1/s windows — absence during a static screen is expected).

If a browser isn't available, a WS client works for checks 1–3: `websocat -H="Cookie: <from /tmp/cj.txt>" -H="Sec-WebSocket-Protocol: binary" wss://swarmagents.codes/desktop/ws?mode=view` — expect the RFB server banner (`RFB 003.008`) as the first bytes (server-first, RFC 6143 — the client speaking first was the B7 bug).

---

## Section 5 — Regression spot-checks (shipped fixes, live behavior)

Run each only if its bundle is in the deployed commit (1.1); otherwise mark "not deployed".

### 5.1 Password reset (fix-39)
On `/login`, click "Forgot password?", submit the operator email. **Expect:** neutral "If an account exists…" confirmation (same for unknown emails — try one: identical response, that's the no-oracle design). The reset email arrives (requires 1.3 SMTP). Click the link → `/reset-password` → set a new password → **Expect:** success state; **all existing sessions die** (the browser session from 3.1 is logged out — epoch bump); sign in with the new password works; reusing the same link → generic 400 (single-use). No email + server logs show a mail warning = SMTP unset (1.3) — by design the endpoint still returned 200.

### 5.2 Email verification + signup gate (fix-41/42/44)
With sign-up posture from 1.3:
- **Closed (`SWARM_ALLOW_SIGNUP` unset):** `/login` shows **no** "Create account" toggle (fix-41: page and API share one predicate). `curl -X POST https://swarmagents.codes/api/signup -d '{"email":"x@y.z","password":"password123"}' -H 'Content-Type: application/json' -H 'Origin: https://swarmagents.codes'` → **403** "Sign-up is disabled on this server."
- **Open (`=1`):** toggle renders; sign up with a fresh email → **201** with `emailVerification: "pending"`; verification email arrives; **before clicking:** sign-in works, provider setup works, but starting a run → 400 "Verify your email…" (fix-44 run gate — fake sign-ups consume no compute). Click the link → run start now succeeds. If Turnstile is configured (1.3): the widget renders on the sign-up form; submitting without solving it → 400 "Bot check failed", no account created.
- The toggle/API mismatch (toggle shown but 403, or hidden but API open) in **any** posture = fix-41 not deployed.

### 5.3 Approvals survive reload (fix-24)
Start a run that triggers an approval-gated tool (e.g., a task that writes outside the workspace or runs a flagged command — any ask-gate). While the approval is pending, **reload the page**. **Expect:** the approval prompt reappears (hydrated from `GET /api/runtime/approvals`, fix-24) and can be approved/denied; the run proceeds accordingly. Before fix-24 the prompt vanished until the 300 s TTL auto-denied. Also confirm the approval is visible from a second browser tab/session opened mid-run.

### 5.4 Desktop takeover safe-point grant (takeover-wiring + fix-31)
During an active run with the desktop connected, click **Take over**. **Expect:** control is granted at the next safe point (tool result / pause), not mid-tool-call; the UI shows you in control; your input drives the VM; the agent does not fight you for input. Hand back → **Expect:** a handback summary (redacted, ≤1,200 chars) is merged into the run and the agent resumes. (With `SWARM_DESKTOP_FRAME_TAP=1`, the summary also carries a frame caption + keyframe reference to the final screen state — handback-frame-summary; with the tap off the summary has no frame reference, which is expected.) If a handoff (`ask_human_desktop`) occurs while you hold control: **Expect** "Control paused — handoff" state (fix-31), and control restores to you after handback only if your session is still live. Takeover request ignored for >15 s = the timeout backstop should force-grant (or deny if `SWARM_TAKEOVER_TIMEOUT_MODE=deny`).

### 5.5 Kill a run with a queued successor → no orphans (fix-20 + fix-36)
Queue two runs for the same user (second waits). While run A is executing something long-lived (e.g., `sleep 600` via a shell task), **cancel run A**. **Expect:** run B starts, and A's processes are gone — verify inside the VM (shell task: `ps aux | grep sleep` shows nothing from A). Before fix-20, kill escalation stood down when a successor took the slot and orphans survived into run B. Also confirms fix-36's reserved control lane: the kill/reap exec runs even while the agent exec holds the general slots (no `QuotaError: max_concurrent_execs` in app logs around the cancel).

### 5.6 Restart resilience (fix-07/08/35, if time permits)
With a run active mid-task, restart the app container (`docker restart <app-container>`). **Expect:** after boot, the run **resumes** (fresh runs now carry a captured `sessionId` — fix-07) or re-queues with its original tool allowlist intact (fix-08 — a restored ambient/allowlisted run must NOT widen to the full toolset); no duplicate manager behavior (fix-35 deferred restore-start). This is the one check that disrupts service — run it last, or skip and mark deferred.

---

## Section 6 — Rollback triggers: revert vs fix-forward

**Revert the deploy (roll back to the previous commit) if any of these hold:**
- `/api/health` not ok, or readiness 503 with a reason that isn't `DESKTOP_IMAGE_MISSING` / `DESKTOP_PROXY_LISTEN_FAILED` with a known one-command fix — the deploy is broken in a way this checklist can't remediate.
- Login is broken for everyone (loop, site-wide 403, or all POSTs 403) and the env/vhost fixes in 1.2/2.2 don't resolve it within one attempt — auth is the front door; don't debug it live with users locked out.
- Section 3 fails at run start with a code error (not an env-naming 400) — e.g., gateway 500s, harness crashes on every run. The first-run path is the product; a broken one blocks everything else.
- BYOK isolation violated: a run succeeds using host keys for a signed-in user who added no key (check: fresh account, no provider, run somehow works) — that's a security/billing incident (B3), revert and investigate before anything else.
- Data loss observed: accounts missing after restart, `users.json` corrupted, runs executing on the wrong workspace (fix-08's fork-seed class). Stop, preserve the storage dir, revert.

**Fix-forward (env/config change + recreate, no revert) for:**
- Any single env var missing/wrong in 1.2–1.3 (set it, `docker compose up -d` to recreate, re-run the failed check).
- `DESKTOP_IMAGE_MISSING` → `./deploy.sh build-desktop`.
- `DESKTOP_PROXY_LISTEN_FAILED` with an identifiable port conflict → free the port / correct `SWARM_DESKTOP_PROXY_HOST`, restart.
- Missing nginx location / `X-Forwarded-Host` (2.2) → install the repo vhost, `nginx -t`, reload.
- Logo LFS pointer (2.7) → `git lfs pull` + rebuild/redeploy that asset only.
- SMTP/Turnstile unset (1.3) while sign-up is closed → schedule before opening sign-up; not a deploy blocker.
- Section 4.1 shows a Mercury-3 stream shape the translator mishandles (name fragmentation) → file the FIX-27 follow-up; runs still work for well-behaved shapes, so this doesn't block launch by itself.
- FIX-37 (4.2 check 2) shows the subprotocol stripped → file the proxy fix; desktop may still work in some clients, but treat as launch-blocking for the desktop surface if noVNC fails to render.

**Escalate to James (don't decide solo):** opening sign-up posture changes, any credential/key handling, anything in the "revert" list that recurs after a revert + redeploy, and the Section 3 result itself — first real run success/failure is the launch gate.

---

## Report template

```
FIX-50 report — <date/time>, deployed commit <sha>
1.1 health/commit: pass|fail — <observed>
1.2 env: SERVER_MODE set|unset, PUBLIC_ORIGIN set|unset, VM_LLM_BASE_URL set|unset,
    SESSION_SECRET set|unset, ALLOWED_HOSTS set|unset, COOKIE_SECURE <v>, VM_DESKTOP <v>,
    DESKTOP_FRAME_TAP <1|off>, MAX_CONCURRENT_VMS <v|default 4>, VM_MEMORY <v|default 2g>,
    HARNESS_TOKEN set|unset
1.3 mail/signup: SMTP_HOST set|unset, MAIL_FROM set|unset, PASSWORD_RESET_TTL_MIN <v|default 30>,
    ALLOW_SIGNUP <posture>, TURNSTILE both|neither|one-only,
    EMAIL_VERIFY_TTL_HOURS <v|default 24>
1.4 .env.v2 / images / ports: pass|fail — <observed>
2.1 nginx -t + reload: pass|fail — <observed>
2.2 vhost locations: pass|fail — <missing, if any>
2.3 health/readiness: pass|fail — <reason if 503>
2.4 Set-Cookie: pass|fail — <flags observed>
2.5 Origin POST: pass|fail — <status>
2.6 SSE incremental: pass|fail|deferred
2.7 logo: pass|fail — <content-type, size>
2.8 status page: pass|fail — <observed>
3.x first real run: pass|fail — run id <id>, model shown <mercury-3|mercury>
4.1 Mercury-3 capture: id/name timing <…>, index always present <y|n>,
    name fragmented <y|n>, interleaving <y|n>
4.2 desktop dial: 101 <y|n>, Sec-WebSocket-Protocol req/resp <…>,
    handshake-timeout in logs <y|n>, frames render <y|n>,
    frame tap (if on): keyframes listed <y|n>, desktop.damage seen <y|n>
5.1 password reset: pass|fail|not deployed — <observed>
5.2 signup gate + verification: pass|fail|not deployed — <observed>
5.3 approvals survive reload: pass|fail|not deployed
5.4 takeover safe-point: pass|fail|not deployed
5.5 cancel-with-successor orphans: pass|fail|not deployed
5.6 restart resilience: pass|fail|deferred
Actions taken: <env changes, builds, reloads — names only, no values>
Rollback needed: no | yes — <trigger>
```
