#!/bin/sh
# Chromium launcher for the desktop VM.
#
# The driver creates desktop containers with --shm-size=1g, so Chromium's
# shared-memory needs are covered and --no-sandbox is NOT used. The remaining
# flags are the standard container/CI-safe set.
#
# The browser profile lives on the /workspace named volume
# (/workspace/.swarm/browser-profile, overridable via
# CHROMIUM_USER_DATA_DIR) so authenticated sessions survive VM hibernation
# and container recreation. The headed Playwright MCP server shares this
# same profile dir. Chromium's singleton lock means a second Chromium on
# this profile attaches to the running instance instead of starting a new
# one — if the desktop browser is already open, an agent browser launch
# reuses that window.
exec /usr/bin/chromium \
  --user-data-dir="${CHROMIUM_USER_DATA_DIR:-/workspace/.swarm/browser-profile}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI \
  --start-maximized \
  "$@"
