#!/usr/bin/env bash
#
# test-all.sh — run the full app quality gate in one shot:
#   typecheck → unit tests → production build → boot the built app against a
#   fake VM driver and a temp SWARM_HOME → local e2e → shutdown.
#
# Exits non-zero on the first failing step (set -e). The app is served on a
# free port and torn down (server killed, temp SWARM_HOME removed) on exit.
set -euo pipefail

cd "$(dirname "$0")/.."

# ── helpers ────────────────────────────────────────────────────────────────
log() { printf '\n═══ %s ═══\n' "$1"; }

# Print an available TCP port on 127.0.0.1.
free_port() {
  node -e 'const net=require("net"),s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}

PORT="${TEST_ALL_PORT:-$(free_port)}"
DESKTOP_PROXY_PORT="${TEST_ALL_DESKTOP_PROXY_PORT:-$(free_port)}"

echo "Running full app gate: typecheck → unit → build → e2e (local, fake VM, temp SWARM_HOME)"
echo "App will listen on http://127.0.0.1:${PORT}"

export SWARM_VM_DRIVER=fake
SWARM_HOME="$(mktemp -d)"
export SWARM_HOME
# Keep the gate self-contained on machines without a /workspace mount.
export SCREENSHOT_DIR="${SCREENSHOT_DIR:-${SWARM_HOME}/e2e-screenshots}"
echo "SWARM_HOME=${SWARM_HOME}"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SWARM_HOME"
}
trap cleanup EXIT

# ── 1. typecheck ───────────────────────────────────────────────────────────
log "1/5 Typecheck (tsc --noEmit)"
npm run typecheck

# ── 2. unit tests ──────────────────────────────────────────────────────────
log "2/5 Unit tests"
npm run test:unit

# ── 3. production build ────────────────────────────────────────────────────
log "3/5 Build (next build)"
npm run build

# ── 4. boot the built app ──────────────────────────────────────────────────
log "4/5 Boot standalone server on ${PORT} (SWARM_VM_DRIVER=fake)"
# Next's standalone output needs static assets copied beside the server.
cp -R .next/static .next/standalone/.next/static
if [[ -d public ]]; then cp -R public .next/standalone/public; fi
HOSTNAME=127.0.0.1 PORT="$PORT" SWARM_DESKTOP_PROXY_PORT="$DESKTOP_PROXY_PORT" node .next/standalone/server.js &
SERVER_PID=$!

ready=false
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.5
done

if [ "$ready" != true ]; then
  echo "Server did not become ready on port ${PORT}" >&2
  exit 1
fi
echo "Server is ready."

# ── 5. local e2e ───────────────────────────────────────────────────────────
log "5/5 E2E (local)"
BASE_URL="http://127.0.0.1:${PORT}" SWARM_E2E_MODE=local npm run test:e2e

log "All gates passed ✅"
