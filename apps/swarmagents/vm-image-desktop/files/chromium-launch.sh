#!/bin/sh
# Chromium launcher for the desktop VM.
#
# The driver creates desktop containers with --shm-size=1g, so Chromium's
# shared-memory needs are covered and --no-sandbox is NOT used. The remaining
# flags are the standard container/CI-safe set.
exec /usr/bin/chromium \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI \
  --start-maximized \
  "$@"
