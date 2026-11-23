#!/usr/bin/env bash
#
# test-all.sh — run the full app quality gate in one shot:
#   typecheck → unit tests → production build → boot the built app against a
#   fake VM driver and a temp SWARM_HOME → local e2e → shutdown.
#
# Exits non-zero on the first failing step (set -e). The boot + e2e half
# lives in scripts/boot-and-e2e.sh so the CI e2e job can run it on its own
# (after build) without re-running the unit suite.
set -euo pipefail

cd "$(dirname "$0")/.."

# ── helpers ────────────────────────────────────────────────────────────────
log() { printf '\n═══ %s ═══\n' "$1"; }

echo "Running full app gate: typecheck → unit → build → e2e (local, fake VM, temp SWARM_HOME)"

# ── 1. typecheck ───────────────────────────────────────────────────────────
log "1/5 Typecheck (tsc --noEmit)"
npm run typecheck

# ── 2. unit tests ──────────────────────────────────────────────────────────
log "2/5 Unit tests"
npm run test:unit

# ── 3. production build ────────────────────────────────────────────────────
log "3/5 Build (next build)"
npm run build

# ── 4-5. boot the built app + local e2e ────────────────────────────────────
# (Fake VM driver, temp SWARM_HOME, free ports — see boot-and-e2e.sh.
# TEST_ALL_PORT / TEST_ALL_DESKTOP_PROXY_PORT still pin the ports.)
log "4/5 Boot + E2E (local)"
scripts/boot-and-e2e.sh

log "All gates passed ✅"
