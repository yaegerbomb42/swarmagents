#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="147.224.158.118"
VPS_USER="ubuntu"
SSH_KEY="$HOME/.ssh/infra_vps_key"
REMOTE_TMP="/tmp/swarmagents_deploy.tar.gz"
# Server-side secrets (NVIDIA_API_KEYS, INCEPTION_API_KEYS, HARNESS_ACCESS_TOKEN, ...) live in
# this file on the VPS (mode 600) and are passed to the container with --env-file. To update it,
# put the values in deploy/.env.production locally (gitignored); it is uploaded, then left alone.
REMOTE_ENV="/home/${VPS_USER}/.swarmagents.env"

echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Preparing build archive..."
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
trap 'rm -f /tmp/swarmagents_deploy.tar.gz' EXIT

tar --exclude='node_modules' --exclude='.next' --exclude='.git' --exclude='dist' \
    --exclude='apps/web/public/startup' --exclude='apps/extension' --exclude='deploy/.env.production' \
    -czf /tmp/swarmagents_deploy.tar.gz -C "$DIR" .

echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Shipping to VPS ($VPS_HOST)..."
scp -i "$SSH_KEY" /tmp/swarmagents_deploy.tar.gz "${VPS_USER}@${VPS_HOST}:${REMOTE_TMP}"

if [ -f "$DIR/deploy/.env.production" ]; then
  echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Uploading server env (deploy/.env.production)..."
  scp -i "$SSH_KEY" "$DIR/deploy/.env.production" "${VPS_USER}@${VPS_HOST}:${REMOTE_ENV}.new"
  ssh -i "$SSH_KEY" "${VPS_USER}@${VPS_HOST}" "chmod 600 ${REMOTE_ENV}.new && mv ${REMOTE_ENV}.new ${REMOTE_ENV}"
fi

echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Building & swapping container on VPS..."
ssh -i "$SSH_KEY" "${VPS_USER}@${VPS_HOST}" bash << 'REMOTE_SCRIPT'
set -euo pipefail
mkdir -p /tmp/swarmagents_build
rm -rf /tmp/swarmagents_build/*
tar -xzf /tmp/swarmagents_deploy.tar.gz -C /tmp/swarmagents_build/
cd /tmp/swarmagents_build/

# Keep the running image as :prev for a one-command rollback:
#   docker rm -f swarmagents-dashboard && docker run -d --name swarmagents-dashboard ... swarmagents-dashboard:prev
docker image inspect swarmagents-dashboard:latest >/dev/null 2>&1 && docker tag swarmagents-dashboard:latest swarmagents-dashboard:prev
docker build -t swarmagents-dashboard:latest -f deploy/Dockerfile .
docker stop swarmagents-dashboard || true
docker rm swarmagents-dashboard || true
ENV_ARGS=()
if [ -f "$HOME/.swarmagents.env" ]; then ENV_ARGS=(--env-file "$HOME/.swarmagents.env"); else echo "[VPS] WARNING: no ~/.swarmagents.env; the engine will run without provider keys"; fi
docker run -d --name swarmagents-dashboard --restart unless-stopped "${ENV_ARGS[@]}" -p 172.17.0.1:3400:3000 swarmagents-dashboard:latest

echo "[VPS] SwarmAgents container is UP on 172.17.0.1:3400"
docker ps --filter name=swarmagents-dashboard
for i in $(seq 1 30); do
  if curl -fsS http://172.17.0.1:3400/api/health >/dev/null 2>&1; then echo "[VPS] health OK"; break; fi
  sleep 2
done
curl -fsS http://172.17.0.1:3400/api/harness/task || true
echo
REMOTE_SCRIPT

echo -e "\033[1;32m[SwarmAgents Deploy]\033[0m Live at https://swarmagents.codes"
