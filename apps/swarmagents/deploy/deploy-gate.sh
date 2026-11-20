#!/usr/bin/env bash
set -euo pipefail

DEPLOY_SCRIPT="/home/ubuntu/infra/apps/swarmagents/deploy.sh"

cmd="${SSH_ORIGINAL_COMMAND:-}"

# Trim leading/trailing whitespace
cmd="$(echo -n "$cmd" | xargs)"

case "$cmd" in
  deploy)
    exec "$DEPLOY_SCRIPT" deploy
    ;;
  status)
    exec "$DEPLOY_SCRIPT" status
    ;;
  rollback)
    exec "$DEPLOY_SCRIPT" rollback
    ;;
  logs)
    exec "$DEPLOY_SCRIPT" logs
    ;;
  build-desktop)
    exec "$DEPLOY_SCRIPT" build-desktop
    ;;
  desktop-on)
    exec "$DEPLOY_SCRIPT" desktop-on
    ;;
  desktop-off)
    exec "$DEPLOY_SCRIPT" desktop-off
    ;;
  cleanup)
    exec "$DEPLOY_SCRIPT" cleanup
    ;;
  *)
    echo "Access denied: command '$cmd' is not permitted." >&2
    echo "Permitted commands: deploy, status, rollback, logs, build-desktop, desktop-on, desktop-off, cleanup" >&2
    exit 1
    ;;
esac
