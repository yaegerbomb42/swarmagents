#!/usr/bin/env bash
# backup.sh — timestamped backup of SwarmAgents persistent data (/data).
#
# /data holds the board (swarm_board.json), users, telemetry, and per-user
# provider keys. It is a single copy: this script is the only in-repo backup.
# Run it on a schedule (see the "Backup and restore" section of DEPLOY.md
# for the systemd timer / cron setup).
#
# What it does:
#   - tars the contents of the data dir into
#     $BACKUP_DIR/swarmagents-backup-YYYYMMDD-HHMMSS.tgz (+ a .sha256 sidecar)
#   - keeps the newest $KEEP backups and deletes older ones (default 7).
#
# What it does NOT do: stop the app. Board writes are atomic (tmp file +
# rename), so a tarball taken while the app runs is at worst a slightly
# stale snapshot — good enough for disaster recovery, not a point-in-time
# freeze. Restore with the app stopped (see restore.sh).
#
# Environment overrides (sensible defaults shown):
#   SWARM_DATA_DIR=/data            (or SWARM_HOME; the app prefers SWARM_HOME)
#   SWARM_BACKUP_DIR=/var/backups/swarmagents
#   SWARM_BACKUP_KEEP=7             number of recent backups to retain
#
# Requires: tar, sha256sum, date. No Docker, no systemd.
set -euo pipefail

DATA_DIR="${SWARM_DATA_DIR:-${SWARM_HOME:-/data}}"
BACKUP_DIR="${SWARM_BACKUP_DIR:-/var/backups/swarmagents}"
KEEP="${SWARM_BACKUP_KEEP:-7}"

die() { echo "backup: ERROR: $*" >&2; exit 1; }

[ -d "$DATA_DIR" ] || die "data dir $DATA_DIR does not exist (nothing to back up)"
case "$KEEP" in ''|*[!0-9]*) die "SWARM_BACKUP_KEEP must be a non-negative integer" ;; esac

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
name="swarmagents-backup-$stamp.tgz"
tmp="$BACKUP_DIR/.${name}.tmp"

# Tar the CONTENTS of the data dir (not the dir itself) so restore is a
# plain extract into the data dir. Clean up the partial file on failure.
trap 'rm -f "$tmp"' EXIT
tar -czf "$tmp" -C "$DATA_DIR" .
mv "$tmp" "$BACKUP_DIR/$name"
trap - EXIT

( cd "$BACKUP_DIR" && sha256sum "$name" > "$name.sha256" )
size="$(du -h "$BACKUP_DIR/$name" | cut -f1)"
echo "backup: wrote $BACKUP_DIR/$name ($size)"

# Retention: keep the newest $KEEP tarballs, delete the rest (sidecars go
# with their tarball). KEEP=0 keeps everything.
if [ "$KEEP" -gt 0 ]; then
  # ls -t, newest first; skip the first $KEEP, delete the rest.
  old="$(ls -t "$BACKUP_DIR"/swarmagents-backup-*.tgz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)"
  if [ -n "$old" ]; then
    echo "$old" | while IFS= read -r f; do
      rm -f "$f" "$f.sha256"
      echo "backup: pruned old backup $(basename "$f")"
    done
  fi
fi

echo "backup: done ($(( $(ls "$BACKUP_DIR"/swarmagents-backup-*.tgz 2>/dev/null | wc -l) )) backup(s) retained)"
