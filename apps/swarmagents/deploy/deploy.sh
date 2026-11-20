#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/ubuntu/infra/apps/swarmagents"
V2_DIR="$APP_DIR/v2"
COMPOSE_FILE="$V2_DIR/docker-compose.server.yml"
ENV_FILE="$APP_DIR/.env.v2"
LOCK_FILE="/tmp/swarmagents-deploy.lock"
COMPOSE_PROJECT="swarmagents-v2"
HEALTH_URL="http://172.17.0.1:3400/api/health?ready=1"
HOST_HEADER="swarmagents.codes"
REPO_DIR="/home/ubuntu/repo/monolith-worktree"
MIRROR_DIR="/home/ubuntu/repo/monolith.git"
DEPLOY_KEY="/home/ubuntu/.ssh/monolith_deploy_key"

exec 200>"$LOCK_FILE"
flock -n 200 || { echo "ERROR: Another deploy is already running (locked $LOCK_FILE)" >&2; exit 1; }

mode="${1:-deploy}"

verify_health() {
  local max_seconds="${1:-90}"
  local start_time elapsed health_ok health_body
  start_time=$(date +%s)
  health_ok=0
  health_body=""

  echo "Polling health check at $HEALTH_URL (up to ${max_seconds}s)..."
  while true; do
    elapsed=$(( $(date +%s) - start_time ))
    if [ "$elapsed" -ge "$max_seconds" ]; then
      break
    fi

    health_body=$(curl -s -f -H "Host: $HOST_HEADER" "$HEALTH_URL" 2>/dev/null || true)
    if [ -n "$health_body" ]; then
      local is_ok is_driver
      is_ok=$(echo "$health_body" | jq -r '.ready // empty' 2>/dev/null || true)
      is_driver=$(echo "$health_body" | jq -r '.vmDriver // empty' 2>/dev/null || true)

      if [ "$is_ok" = "true" ] && [ "$is_driver" = "docker" ]; then
        health_ok=1
        break
      fi
    fi
    sleep 3
  done

  if [ "$health_ok" -eq 1 ]; then
    echo "Health check succeeded."
    echo "$health_body" | (jq . 2>/dev/null || cat)
    return 0
  else
    echo "ERROR: Health check failed or timed out after ${max_seconds}s!" >&2
    echo "Last health response: $health_body" >&2
    return 1
  fi
}

do_cleanup() {
  echo "=== SWARMAGENTS CLEANUP ==="
  local avail_before avail_after
  avail_before=$(df -k / | awk 'NR==2 {print $4}')

  echo "Pruning old swarmagents-v2 images..."
  # Prune old dashboard images: keep latest, prev, and 3 newest prev-<timestamp> tags
  python3 -c "
import subprocess

# Running image IDs to ensure we never remove an image a running container uses
running_images = set(subprocess.check_output(['docker', 'ps', '--format', '{{.Image}}']).decode().splitlines())

all_tags = subprocess.check_output(['docker', 'images', 'swarmagents-v2', '--format', '{{.Repository}}:{{.Tag}}']).decode().splitlines()
all_tags = [t.strip() for t in all_tags if t.strip()]

keep = {'swarmagents-v2:latest', 'swarmagents-v2:prev'}
timestamp_tags = [t for t in all_tags if t.startswith('swarmagents-v2:prev-')]
timestamp_tags.sort(reverse=True)
keep.update(timestamp_tags[:3])

for tag in all_tags:
    if tag not in keep and tag not in running_images:
        print(f'Removing old image tag: {tag}')
        try:
            subprocess.run(['docker', 'rmi', tag], check=False)
        except Exception as e:
            print(f'Warning: failed to remove {tag}: {e}')
"

  echo "Pruning dangling docker images..."
  docker image prune -f

  echo "Pruning old backup files (keeping 5 newest of each)..."
  python3 -c "
import glob, os

patterns = [
    '$APP_DIR/.env.v2.bak-*',
    '$V2_DIR/docker-compose.server.yml.bak-*',
    '$APP_DIR/v2-src-prev-*.tgz'
]

for pattern in patterns:
    files = glob.glob(pattern)
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    to_delete = files[5:]
    for f in to_delete:
        print(f'Removing old backup: {f}')
        try:
            os.remove(f)
        except Exception as e:
            print(f'Warning: failed to remove {f}: {e}')
"

  avail_after=$(df -k / | awk 'NR==2 {print $4}')
  local freed_k=$(( avail_after - avail_before ))
  if [ "$freed_k" -lt 0 ]; then
    freed_k=0
  fi
  local freed_mb=$(( freed_k / 1024 ))
  echo "Disk space freed: ${freed_mb} MB (${freed_k} KB)"
  echo "Current disk space on /:"
  df -h /
  echo "Remaining swarmagents-v2 images:"
  docker images swarmagents-v2 --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}"
}

do_status() {
  echo "=== SWARMAGENTS STATUS ==="
  echo "--- Docker Containers ---"
  docker ps --filter "name=swarmagents" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"
  echo ""
  echo "--- Running Image Details ---"
  docker images --filter "reference=swarmagents-v2" --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}"
  echo ""
  echo "--- /api/health Output ---"
  local health_out
  health_out=$(curl -s -f -H "Host: $HOST_HEADER" "$HEALTH_URL" 2>/dev/null || true)
  if [ -n "$health_out" ]; then
    echo "$health_out" | (jq . 2>/dev/null || cat)
  else
    echo "ERROR: Unable to reach $HEALTH_URL"
    exit 1
  fi
}

do_logs() {
  echo "=== SWARMAGENTS LOGS (Last 200 lines, redacted) ==="
  docker logs --tail 200 swarmagents-dashboard 2>&1 | \
    sed -E -e 's/([kK][eE][yY]|[tT][oO][kK][eE][nN]|[pP][aA][sS][sS][wW][oO][rR][dD]|[sS][eE][cC][rR][eE][tT])(=|:)[^ &"]+/\1\2[REDACTED]/g' \
           -e 's/(Bearer )[A-Za-z0-9._~+/-]+/\1[REDACTED]/g' \
           -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...[REDACTED]/g' \
           -e 's/([0-9a-fA-F]{32,64})/[REDACTED_HASH]/g'
}

do_rollback() {
  echo "=== SWARMAGENTS ROLLBACK ==="
  # Find latest prev image tag
  local prev_tag
  prev_tag=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^swarmagents-v2:prev' | head -n 1 || true)
  if [ -z "$prev_tag" ]; then
    echo "ERROR: No swarmagents-v2:prev tag found to rollback to!" >&2
    exit 1
  fi

  echo "Restoring image $prev_tag -> swarmagents-v2:latest..."
  docker tag "$prev_tag" swarmagents-v2:latest

  # Find newest .env.v2 and docker-compose backups
  local latest_env_bak latest_compose_bak
  latest_env_bak=$(ls -t "$APP_DIR"/.env.v2.bak-* 2>/dev/null | head -n 1 || true)
  latest_compose_bak=$(ls -t "$V2_DIR"/docker-compose.server.yml.bak-* 2>/dev/null | head -n 1 || true)

  if [ -n "$latest_env_bak" ] && [ -f "$latest_env_bak" ]; then
    echo "Restoring .env.v2 from $latest_env_bak..."
    cp "$latest_env_bak" "$ENV_FILE"
  fi

  if [ -n "$latest_compose_bak" ] && [ -f "$latest_compose_bak" ]; then
    echo "Restoring docker-compose.server.yml from $latest_compose_bak..."
    cp "$latest_compose_bak" "$COMPOSE_FILE"
  fi

  echo "Restarting containers with previous image..."
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build

  echo "Verifying health after rollback..."
  # The rolled-back deployment is only a successful rollback when it is
  # actually healthy: poll the readiness endpoint (up to 90s) and FAIL
  # the rollback when it never becomes ready, instead of silently leaving
  # an unhealthy container behind. Callers (deploy on health failure, and
  # the `rollback` mode) exit non-zero on this so the failure is visible.
  if ! verify_health 90; then
    echo "ERROR: Rollback restored $prev_tag but the container is not healthy — manual intervention required (check 'logs' and /api/health?ready=1)." >&2
    exit 1
  fi
}

do_build_desktop() {
  echo "=== SWARMAGENTS BUILD DESKTOP IMAGE ==="
  echo "Refreshing local git mirror from GitHub..."
  if [ ! -d "$MIRROR_DIR" ]; then
    echo "ERROR: Mirror directory $MIRROR_DIR does not exist!" >&2
    exit 1
  fi

  GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o StrictHostKeyChecking=accept-new" \
    git -C "$MIRROR_DIR" fetch origin main:main

  echo "Pulling latest code into worktree $REPO_DIR..."
  git -C "$REPO_DIR" pull --ff-only origin main

  echo "Building swarm-vm:desktop from apps/swarmagents/vm-image-desktop..."
  cd "$REPO_DIR/apps/swarmagents/vm-image-desktop"
  docker build -t swarm-vm:desktop .
  rsync -avz --delete "$REPO_DIR/apps/swarmagents/vm-image-desktop/" "$APP_DIR/vm-image-desktop/"
  echo "Build complete. Docker image details:"
  docker images swarm-vm:desktop --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}"
}

do_desktop_on() {
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)

  echo "=== SWARMAGENTS DESKTOP ON [timestamp: $timestamp] ==="
  echo "Backing up .env.v2..."
  cp "$ENV_FILE" "$ENV_FILE.bak-$timestamp"

  echo "Setting SWARM_VM_DESKTOP=1 in $ENV_FILE..."
  python3 -c "
with open('$ENV_FILE', 'r') as f:
    lines = f.readlines()
new_lines = []
desktop_found = False
for line in lines:
    if line.startswith('SWARM_VM_DESKTOP='):
        new_lines.append('SWARM_VM_DESKTOP=1\n')
        desktop_found = True
    else:
        new_lines.append(line)
if not desktop_found:
    new_lines.append('SWARM_VM_DESKTOP=1\n')
with open('$ENV_FILE', 'w') as f:
    f.writelines(new_lines)
"

  echo "Restarting containers with docker compose up -d --no-build..."
  cd "$APP_DIR"
  if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build; then
    echo "ERROR: docker compose up failed! Rolling back .env.v2..." >&2
    cp "$ENV_FILE.bak-$timestamp" "$ENV_FILE"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build
    exit 1
  fi

  if ! verify_health 90; then
    echo "ERROR: Health check failed! Rolling back .env.v2..." >&2
    cp "$ENV_FILE.bak-$timestamp" "$ENV_FILE"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build
    exit 1
  fi
  echo "=== DESKTOP ON SUCCESSFUL ==="
}

do_desktop_off() {
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)

  echo "=== SWARMAGENTS DESKTOP OFF [timestamp: $timestamp] ==="
  echo "Backing up .env.v2..."
  cp "$ENV_FILE" "$ENV_FILE.bak-$timestamp"

  echo "Removing SWARM_VM_DESKTOP from $ENV_FILE..."
  python3 -c "
with open('$ENV_FILE', 'r') as f:
    lines = f.readlines()
new_lines = [line for line in lines if not line.startswith('SWARM_VM_DESKTOP=')]
with open('$ENV_FILE', 'w') as f:
    f.writelines(new_lines)
"

  echo "Restarting containers with docker compose up -d --no-build..."
  cd "$APP_DIR"
  if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build; then
    echo "ERROR: docker compose up failed! Rolling back .env.v2..." >&2
    cp "$ENV_FILE.bak-$timestamp" "$ENV_FILE"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build
    exit 1
  fi

  if ! verify_health 90; then
    echo "ERROR: Health check failed! Rolling back .env.v2..." >&2
    cp "$ENV_FILE.bak-$timestamp" "$ENV_FILE"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build
    exit 1
  fi
  echo "=== DESKTOP OFF SUCCESSFUL ==="
}

do_deploy() {
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)

  echo "=== SWARMAGENTS DEPLOY START [timestamp: $timestamp] ==="

  # 1. Refresh mirror directly from GitHub
  echo "Refreshing local git mirror from GitHub..."
  if [ ! -d "$MIRROR_DIR" ]; then
    echo "ERROR: Mirror directory $MIRROR_DIR does not exist!" >&2
    exit 1
  fi

  GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o StrictHostKeyChecking=accept-new" \
    git -C "$MIRROR_DIR" fetch origin main:main

  # 2. Sync worktree from mirror
  echo "Pulling latest code into worktree $REPO_DIR..."
  local old_head new_head
  old_head=$(git -C "$REPO_DIR" rev-parse HEAD)
  git -C "$REPO_DIR" pull --ff-only origin main
  new_head=$(git -C "$REPO_DIR" rev-parse HEAD)
  echo "Target HEAD: $new_head (previously: $old_head)"

  # 3. Tag current image as prev, timestamped
  echo "Backing up current image..."
  local current_id
  current_id=$(docker images -q swarmagents-v2:latest || true)
  if [ -n "$current_id" ]; then
    docker tag swarmagents-v2:latest "swarmagents-v2:prev-$timestamp"
    docker tag swarmagents-v2:latest swarmagents-v2:prev
  fi

  # 4. Back up .env.v2 and the compose file
  echo "Backing up .env.v2 and compose file..."
  cp "$ENV_FILE" "$ENV_FILE.bak-$timestamp"
  cp "$COMPOSE_FILE" "$COMPOSE_FILE.bak-$timestamp"

  # Archive v2 source
  tar -czf "$APP_DIR/v2-src-prev-$timestamp.tgz" -C "$APP_DIR" v2

  # Check if apps/swarmagents/vm-image changed
  local vm_changed=0
  if git -C "$REPO_DIR" diff --quiet "$old_head" "$new_head" -- apps/swarmagents/vm-image 2>/dev/null; then
    vm_changed=0
  else
    vm_changed=1
  fi

  if [ "$vm_changed" -eq 1 ]; then
    echo "apps/swarmagents/vm-image changed. Rebuilding swarm-vm:claude..."
    cd "$REPO_DIR/apps/swarmagents/vm-image"
    docker build -t swarm-vm:claude .
    rsync -avz --delete "$REPO_DIR/apps/swarmagents/vm-image/" "$APP_DIR/vm-image/"
  else
    echo "apps/swarmagents/vm-image unchanged. Skipping VM image rebuild."
  fi

  # Check if apps/swarmagents/vm-image-desktop changed
  local vm_desktop_changed=0
  if git -C "$REPO_DIR" diff --quiet "$old_head" "$new_head" -- apps/swarmagents/vm-image-desktop 2>/dev/null; then
    vm_desktop_changed=0
  else
    vm_desktop_changed=1
  fi

  if [ "$vm_desktop_changed" -eq 1 ]; then
    echo "apps/swarmagents/vm-image-desktop changed. Rebuilding swarm-vm:desktop..."
    cd "$REPO_DIR/apps/swarmagents/vm-image-desktop"
    docker build -t swarm-vm:desktop .
    rsync -avz --delete "$REPO_DIR/apps/swarmagents/vm-image-desktop/" "$APP_DIR/vm-image-desktop/"
  else
    echo "apps/swarmagents/vm-image-desktop unchanged. Skipping desktop VM image rebuild."
  fi

  # Sync source to v2
  echo "Syncing updated source to $V2_DIR..."
  rsync -avz --exclude "node_modules" --exclude ".next" --exclude ".git" \
    --exclude ".env*" --exclude "*.bak*" --exclude "docker-compose.server.yml*" \
    "$REPO_DIR/apps/swarmagents/" "$V2_DIR/"

  # Rebuild the app image
  echo "Rebuilding swarmagents-v2:latest..."
  cd "$V2_DIR"
  if ! docker build -t swarmagents-v2:latest .; then
    echo "ERROR: docker build failed!" >&2
    echo "Rolling back..."
    do_rollback
    exit 1
  fi

  # Update deploy env in .env.v2 (git SHA and proxy trust for correct per-IP rate limiting)
  echo "Updating SWARM_GIT_SHA and proxy rate-limit env in .env.v2..."
  python3 -c "
with open('$ENV_FILE', 'r') as f:
    lines = f.readlines()
updates = {
    'SWARM_GIT_SHA': '$new_head',
    'SWARM_TRUST_PROXY': '1',
    'SWARM_TRUSTED_PROXY_HOPS': '1',
}
new_lines = []
seen = set()
for line in lines:
    key = line.split('=', 1)[0]
    if key in updates:
        new_lines.append(f'{key}={updates[key]}\n')
        seen.add(key)
    else:
        new_lines.append(line)
for key, value in updates.items():
    if key not in seen:
        new_lines.append(f'{key}={value}\n')
with open('$ENV_FILE', 'w') as f:
    f.writelines(new_lines)
"

  # Run compose up -d --no-build
  echo "Running docker compose up -d --no-build..."
  cd "$APP_DIR"
  if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --no-build; then
    echo "ERROR: docker compose up failed!" >&2
    echo "Rolling back..."
    do_rollback
    exit 1
  fi

  # Poll /api/health for up to 90 seconds
  if verify_health 90; then
    echo "=== DEPLOY SUCCESSFUL ==="
    echo "Commit: $new_head"
    # Run cleanup step after deploy passes health check
    do_cleanup
    exit 0
  else
    echo "Rolling back..."
    do_rollback
    exit 1
  fi
}

case "$mode" in
  status)
    do_status
    ;;
  logs)
    do_logs
    ;;
  rollback)
    do_rollback
    ;;
  deploy)
    do_deploy
    ;;
  build-desktop)
    do_build_desktop
    ;;
  desktop-on)
    do_desktop_on
    ;;
  desktop-off)
    do_desktop_off
    ;;
  cleanup)
    do_cleanup
    ;;
  *)
    echo "Usage: $0 {deploy|status|rollback|logs|build-desktop|desktop-on|desktop-off|cleanup}" >&2
    exit 1
    ;;
esac
