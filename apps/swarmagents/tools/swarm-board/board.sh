#!/usr/bin/env bash
# Swarm board client: works from any machine, no server access needed.
# Auth: SWARM_BOARD_TOKEN (harness bearer) if set, else signs in with
# SWARM_EMAIL + SWARM_PASSWORD and caches the session cookie.
# Usage: board.sh <tool> '<json args>'     e.g. board.sh poll_tasks '{}'
#        board.sh tools                    (list board tools)
set -euo pipefail
URL="${SWARM_BOARD_URL:-https://swarmagents.codes}"
JAR="${SWARM_BOARD_COOKIES:-$HOME/.swarm-board-cookies}"
tool="${1:?usage: board.sh <tool> '<json args>' | tools}"; args="${2:-{\}}"
if [ "$tool" = tools ]; then body='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
else body=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$tool" "$args"); fi
login() {
  : "${SWARM_EMAIL:?set SWARM_EMAIL and SWARM_PASSWORD (or SWARM_BOARD_TOKEN)}"; : "${SWARM_PASSWORD:?}"
  python3 -c 'import json,os;print(json.dumps({"email":os.environ["SWARM_EMAIL"],"password":os.environ["SWARM_PASSWORD"]}))' |
    curl -s -m 30 -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "$URL/api/login" -H 'Content-Type: application/json' --data-binary @- | grep -q '^20' \
    || { echo "board.sh: login failed" >&2; exit 1; }
  chmod 600 "$JAR"
}
call() {
  if [ -n "${SWARM_BOARD_TOKEN:-}" ]; then
    curl -s -m 30 -X POST "$URL/api/mcp/swarm-board" -H "Authorization: Bearer $SWARM_BOARD_TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -m 30 -b "$JAR" -X POST "$URL/api/mcp/swarm-board" -H 'Content-Type: application/json' -d "$body"
  fi
}
[ -n "${SWARM_BOARD_TOKEN:-}" ] || [ -s "$JAR" ] || login
out=$(call)
if printf '%s' "$out" | grep -q 'Sign in required'; then
  [ -n "${SWARM_BOARD_TOKEN:-}" ] && { echo "board.sh: SWARM_BOARD_TOKEN rejected (server SWARM_HARNESS_TOKEN differs)" >&2; exit 1; }
  login; out=$(call)
fi
printf '%s\n' "$out"
