# LAUNCH CHECKLIST — swarmagents.codes public sign-up (finish-launch)

Each gate: status + the command that proves it. Re-verify after any deploy.

| # | Gate | Status | Prove it |
|---|------|--------|----------|
| 1 | Auth gate: local 200/403, server 303/401/200, no-token 503 | ✅ PASS | `node tests/auth-gate.mjs` (34 pass) |
| 2 | Tenant isolation alice/bob/mallory (sessions, files, admin APIs) | ✅ PASS (unit) / 🟡 LIVE via deploy | `npm run test:tenant`; live: `TENANT_BASE=<url> node tests/tenant-isolation.mjs` (deploy preflight runs `infra/host/swarmagents-tenant-probe.sh`) |
| 3 | Saved keys reach shell only per-key opt-in (default off), redacted in output | ✅ PASS | `npm run test:tenant` (K2) + e2e `shellkey` |
| 4 | Disk caps: app 507 + kernel quotas match 0.5 GB / 5 GB | 🟡 APP ✅ / OS ⏳ INSTALL | app: e2e `storage`; OS: install `infra/host/swarmagents-quota.{sh,service,timer}` (`deploy.sh --swarmagents-quota`), then `--check` + `repquota` |
| 5 | Nightly backup, 7-day retention, restore tested | ✅ TESTED / off-server ⏳ DECISION | mechanism proven on scratch volumes (WAL db integrity ok, cache excluded, 0600); timer `swarmagents-backup.timer`; destination: **Jimmy picks** (proposal: age-encrypted R2, else rsync.net) |
| 6 | Abuse: sign-up 5/IP/hr + 60/hr, login 5/min, SMTP 25/465/587 dropped, per-proc rlimits + container caps | ✅ SHIPPED / captcha+queue ⏳ DECISION | `node tests/signup-limit.mjs` (10/10); egress: `iptables -t mangle -S SWARMAGENTS-EGRESS`; captcha/PoW and full run-queue are **Jimmy decisions** (phase-2 broker is the queue answer) |
| 7 | Shared compose survives missing aria/.env (real secrets untouched) | ✅ SHIPPED | `docker compose config` no longer fails on absent `apps/aria/.env` (`required: false`) |
| 8 | Browser OFF on server until per-user profiles proven | ✅ GUARDED / profiles ⏳ BROWSER LANE | `grep SWARM_BROWSER_SERVER lib/browser/runtime.ts` (fail-closed). Do NOT set `SWARM_BROWSER_SERVER=on` until the alice/bob/mallory cookie test passes with the profile-lock fix |
| 9 | Security headers (frame-ancestors self, nosniff, same-origin referrer) + preview sandbox CSP + HttpOnly/Strict cookies + SSRF blocks + no secrets in tree | ✅ PASS | `curl -sI` shows headers; e2e `files`; `npm audit` shows only build-time postcss (accepted: attacker CSS never reaches the build) |
| 10 | Suites green: `npm test`, `test:tenant`, e2e | ✅ PASS | `npm test` / `npm run test:tenant` / `npm run test:e2e` (mock LLM, self-contained) |

Legend: ✅ verified · 🟡 verified locally, needs VPS/deploy step · ⏳ needs install or decision.

## Jimmy decisions (blocking or explicitly yours)
1. **Backup destination** (item 5): age-encrypted R2 vs rsync.net vs other. Archives contain user API keys — must be encrypted before upload.
2. **Sign-up captcha/PoW** (item 6): rate limits alone vs Hashcash-style PoW vs hCaptcha.
3. **Run queue** (item 6): launch with 2-runs/account + container caps only, or wait for phase-2 broker.
4. **Admin password file**: must be 10+ chars at `~/.swarmagents/admin-password` (mode 600) or bootstrap skips it.
5. **v1 engine leftovers**: shared compose still hard-fails on missing `apps/swarmagents/engine/.env.clean` — remove the v1 engine service or restore its env file (deploy lane).
