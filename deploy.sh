#!/usr/bin/env bash
# SwarmAgents deploy entry point. See docs/deploy/README.md.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/apps/swarmagents/deploy/ship.sh" "$@"
