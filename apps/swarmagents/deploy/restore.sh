#!/usr/bin/env bash
# restore.sh — restore a SwarmAgents /data backup created by backup.sh.
#
# Usage: restore.sh <backup-file.tgz> [--force]
#
# Safety checks (the script refuses instead of guessing):
#   1. The backup file must exist and be a readable gzip tarball
#      (verified with `tar -tzf` before anything is touched).
#   2. If a <backup-file>.sha256 sidecar exists, its checksum must match.
#   3. If the data dir is non-empty, --force is required: restoring over
#      live board/users/telemetry destroys the current state. The current
#      state is NOT backed up by this script — run backup.sh first if the
#      live data might still matter.
#   4. If Docker is available and a container named `swarmagents` is
#      running, the script refuses unless --force is given: restoring under
#      a running app can interleave with live writes. Stop the app first
#      (docker compose stop / docker stop swarmagents) whenever possible.
#
# The backup file itself is never modified. Rollback (deploy.sh) restores
# the image and config but NEVER /data — this script is the only way /data
# comes back, so treat its output as the last word on what is on disk.
#
# Environment overrides (sensible defaults shown):
#   SWARM_DATA_DIR=/data            (or SWARM_HOME; the app prefers SWARM_HOME)
#   SWARM_RESTORE_CONTAINER=swarmagents   container name checked in check 4
set -euo pipefail

DATA_DIR="${SWARM_DATA_DIR:-${SWARM_HOME:-/data}}"
CONTAINER="${SWARM_RESTORE_CONTAINER:-swarmagents}"
FORCE=false
BACKUP=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    -h|--help)
      echo "Usage: $0 <backup-file.tgz> [--force]"
      echo "Restores a backup.sh tarball into \$SWARM_DATA_DIR (default /data)."
      exit 0 ;;
    *) [ -z "$BACKUP" ] || { echo "restore: ERROR: unexpected argument: $arg" >&2; exit 1; }
       BACKUP="$arg" ;;
  esac
done

die() { echo "restore: ERROR: $*" >&2; exit 1; }

[ -n "$BACKUP" ] || die "no backup file given (usage: $0 <backup-file.tgz> [--force])"
[ -f "$BACKUP" ] || die "backup file not found: $BACKUP"

# 1. The archive must list cleanly (catches truncation/corruption up front).
entries="$(tar -tzf "$BACKUP" 2>/dev/null)" || die "not a readable gzip tarball: $BACKUP"
[ -n "$entries" ] || die "backup archive is empty: $BACKUP"

# 2. Checksum sidecar, when present.
if [ -f "$BACKUP.sha256" ]; then
  ( cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256" >/dev/null ) \
    || die "sha256 mismatch for $BACKUP (archive is corrupt or tampered with)"
  echo "restore: sha256 verified"
fi

# 3. Never silently overwrite live data.
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  $FORCE || die "$DATA_DIR is non-empty — re-run with --force to overwrite it (back it up first with backup.sh if the live data might matter)"
fi

# 4. Refuse to restore under a running app unless forced.
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    $FORCE || die "container $CONTAINER is running — stop it first (docker compose stop), or re-run with --force"
    echo "restore: WARNING: container $CONTAINER is still running; restore may interleave with live writes" >&2
  fi
fi

mkdir -p "$DATA_DIR"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$BACKUP" -C "$stage"
# Copy over (do not wipe the target first: --force already gated the
# overwrite, and a partial extract must not leave an empty data dir).
cp -a "$stage"/. "$DATA_DIR"/
echo "restore: restored $BACKUP into $DATA_DIR"
echo "restore: start the app again (docker compose up -d) and check /api/health?ready=1"
