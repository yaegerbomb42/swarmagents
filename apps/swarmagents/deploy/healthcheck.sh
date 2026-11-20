#!/usr/bin/env bash
# healthcheck.sh — external uptime check for SwarmAgents.
#
# Polls GET /api/health?ready=1 (default http://127.0.0.1:3777) and exits
# 0 only when the endpoint answers HTTP 2xx AND reports "ready": true
# (board writable, disk OK, Docker daemon reachable when the Docker VM
# driver is selected). Any other outcome exits 1 with the reason on stderr,
# so systemd/cron/Monit-style callers can alert on it.
#
# Dependency-light on purpose: curl only (no jq, no node). The readiness
# body is small JSON; readiness is detected with grep, tolerating whitespace.
#
# Environment overrides (sensible defaults shown):
#   SWARM_HEALTH_URL=http://127.0.0.1:3777/api/health?ready=1
#   SWARM_HEALTH_TIMEOUT=10        curl max time, seconds
#
# Scheduling: install alongside the example
# swarmagents-healthcheck.{service,timer} in this directory for a 5-minute
# systemd check, or add a cron line (see the "Monitoring" section of
# DEPLOY.md). Note the timer alone only records failures in the journal —
# it does not page anyone; wire OnFailure= or an external uptime monitor
# for alerting.
set -euo pipefail

URL="${SWARM_HEALTH_URL:-http://127.0.0.1:3777/api/health?ready=1}"
TIMEOUT="${SWARM_HEALTH_TIMEOUT:-10}"

body="$(curl -sS -m "$TIMEOUT" -o /dev/stdout -w '\n%{http_code}' "$URL" 2>&1)" \
  || { echo "healthcheck: ERROR: curl failed for $URL: ${body%$'\n'*}" >&2; exit 1; }

code="${body##*$'\n'}"
payload="${body%$'\n'*}"

case "$code" in
  2*) ;;
  *) echo "healthcheck: ERROR: $URL answered HTTP $code: $payload" >&2; exit 1 ;;
esac

if printf '%s' "$payload" | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
  echo "healthcheck: OK ($URL, HTTP $code, ready=true)"
  exit 0
fi

echo "healthcheck: ERROR: $URL answered HTTP $code but ready is not true: $payload" >&2
exit 1
