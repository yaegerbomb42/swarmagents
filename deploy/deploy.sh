#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="147.224.158.118"
VPS_USER="ubuntu"
SSH_KEY="$HOME/.ssh/infra_vps_key"
REMOTE_TMP="/tmp/swarmagents_deploy.tar.gz"

echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Preparing build archive..."
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

tar --exclude='node_modules' --exclude='.next' --exclude='.git' \
    -czf /tmp/swarmagents_deploy.tar.gz -C "$DIR" .

echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Shipping to VPS ($VPS_HOST)..."
scp -i "$SSH_KEY" /tmp/swarmagents_deploy.tar.gz "${VPS_USER}@${VPS_HOST}:${REMOTE_TMP}"

echo -e "\033[1;36m[SwarmAgents Deploy]\033[0m Building & swapping container on VPS..."
ssh -i "$SSH_KEY" "${VPS_USER}@${VPS_HOST}" bash << 'REMOTE_SCRIPT'
set -euo pipefail
mkdir -p /tmp/swarmagents_build
rm -rf /tmp/swarmagents_build/*
tar -xzf /tmp/swarmagents_deploy.tar.gz -C /tmp/swarmagents_build/
cd /tmp/swarmagents_build/

docker build -t swarmagents-dashboard:latest -f deploy/Dockerfile .
docker stop swarmagents-dashboard || true
docker rm swarmagents-dashboard || true
docker run -d --name swarmagents-dashboard --restart unless-stopped -p 172.17.0.1:3400:3000 swarmagents-dashboard:latest

echo "[VPS] SwarmAgents container is UP on 172.17.0.1:3400"
docker ps --filter name=swarmagents-dashboard
REMOTE_SCRIPT

echo -e "\033[1;32m[SwarmAgents Deploy]\033[0m Live at https://swarmagents.codes"
