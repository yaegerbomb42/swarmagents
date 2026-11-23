#!/usr/bin/env bash
#
# test-unit.sh — run the unit suite with an isolated, self-cleaning SWARM_HOME.
#
# `npm run test:unit` used to inline `SWARM_HOME=$(mktemp -d)` with no
# cleanup, so every run leaked a /tmp/tmp.* directory (and the dev loop runs
# it many times per session). This wrapper owns the temp home: it creates one
# only when the caller did not already provide SWARM_HOME, and removes it on
# exit — success, failure, or interruption — so repeated runs leave nothing
# behind and parallel runs never share (or collide on) a home.
#
# A caller-provided SWARM_HOME is left alone: scripts/test-all.sh exports
# its own temp home and then calls `npm run test:unit`, and deleting that
# home here would break the e2e steps that follow.
set -uo pipefail

cd "$(dirname "$0")/.."

OWNED_HOME=0
if [ -z "${SWARM_HOME:-}" ]; then
  SWARM_HOME="$(mktemp -d)"
  export SWARM_HOME
  OWNED_HOME=1
fi

cleanup() {
  if [ "$OWNED_HOME" = 1 ]; then
    rm -rf "$SWARM_HOME"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tsx --test --test-concurrency=1 \
  "lib/**/*.test.ts" \
  "app/**/*.test.ts" \
  "components/**/*.test.ts" \
  "minimalist-ui/src/**/*.test.ts" \
  "packages/swarm-node/src/**/*.test.ts" \
  "scripts/**/*.test.ts" \
  "$@"
