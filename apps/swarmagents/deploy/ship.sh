#!/usr/bin/env bash
# Run a SwarmAgents deploy action on the production VPS over SSH.
#
#   ./deploy.sh <deploy|status|rollback|logs|build-desktop|desktop-on|desktop-off|cleanup>
#
# The VPS key is restricted by a forced command (deploy-gate.sh), so the only
# thing this script can ever ask the server to do is one of the whitelisted
# actions above. The server pulls origin/main from GitHub itself, so `deploy`
# ships whatever is on main at that moment; merge first, then deploy.
#
# Environment (no secrets are stored in the repo):
#   DEPLOY_SSH_KEY        path to the private key file   (default ~/.ssh/swarm_deploy)
#   DEPLOY_HOST           VPS host or IP                 (required; ask the owner)
#   DEPLOY_USER           VPS user                       (default ubuntu)
#   DEPLOY_KNOWN_HOSTS    optional known_hosts file to pin the host key
set -euo pipefail

action="${1:-status}"
case "$action" in
  deploy|status|rollback|logs|build-desktop|desktop-on|desktop-off|cleanup) ;;
  *) echo "usage: $0 <deploy|status|rollback|logs|build-desktop|desktop-on|desktop-off|cleanup>" >&2; exit 2 ;;
esac

key="${DEPLOY_SSH_KEY:-$HOME/.ssh/swarm_deploy}"
host="${DEPLOY_HOST:?set DEPLOY_HOST to the VPS host or IP (ask the owner)}"
user="${DEPLOY_USER:-ubuntu}"
[ -r "$key" ] || { echo "ship: cannot read deploy key at $key (set DEPLOY_SSH_KEY)" >&2; exit 1; }

opts=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15)
if [ -n "${DEPLOY_KNOWN_HOSTS:-}" ]; then
  opts+=(-o UserKnownHostsFile="$DEPLOY_KNOWN_HOSTS" -o StrictHostKeyChecking=yes)
else
  opts+=(-o StrictHostKeyChecking=accept-new)
fi

exec ssh "${opts[@]}" "$user@$host" "$action"
