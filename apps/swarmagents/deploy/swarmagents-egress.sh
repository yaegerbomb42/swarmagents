#!/usr/bin/env bash
# swarmagents-egress.sh — per-user VM egress firewall for SwarmAgents.
#
# What it does: restricts egress from the per-user VM network to the public
# internet only. Blocked for VM traffic:
#   - cloud instance metadata (Oracle IMDS at 169.254.169.254), EXCEPT DNS
#     on :53, which is the VCN resolver;
#   - the tailnet (100.64.0.0/10 — the operator's own machines);
#   - private ranges (other containers, the host, host-published ports
#     reached via DNAT);
#   - outbound mail submission (SMTP ports 25, 465, 587).
# Everything else (public HTTPS to LLM providers, package registries, …)
# is allowed, so the agent keeps working.
#
# How it works: a dedicated chain SWARMAGENTS-EGRESS in the mangle table's
# PREROUTING chain, jumped to only for traffic sourced from the VM network
# subnet. It is evaluated ahead of Tailscale's FORWARD accept, and it touches
# no other container or network. Idempotent — safe to re-run at any time.
#
# Subnet discovery: at deploy time (Docker running) the subnet is read from
# the Docker network (default: swarmagents-isolated) and saved to
# /etc/swarmagents-egress.subnet. At boot time (Before docker.service, so
# Docker is not up yet) the saved subnet is reused. If Docker is down AND
# no subnet was ever saved, the script fails loudly instead of installing
# a rule for the wrong network.
#
# Installed once by the operator (see DEPLOY.md) as a systemd oneshot:
#   /usr/local/sbin/swarmagents-egress.sh        (this file, mode 755)
#   /etc/systemd/system/swarmagents-egress.service
# Requires: iptables, docker (deploy path only), root. No other dependencies.
#
# Environment overrides (sensible defaults shown):
#   SWARM_EGRESS_NETWORK=swarmagents-isolated   Docker network of the VMs
#   SWARM_EGRESS_SUBNET_FILE=/etc/swarmagents-egress.subnet
#   SWARM_EGRESS_SUBNET=172.30.0.0/16           explicit subnet (skips Docker)
#
# Safety net: this script never removes its own rules. The deploy script
# verifies public HTTPS still works from the agent container after applying
# the policy, and removes the PREROUTING jump if it does not.
set -euo pipefail

CHAIN="SWARMAGENTS-EGRESS"
NETWORK="${SWARM_EGRESS_NETWORK:-swarmagents-isolated}"
SUBNET_FILE="${SWARM_EGRESS_SUBNET_FILE:-/etc/swarmagents-egress.subnet}"
SUBNET="${SWARM_EGRESS_SUBNET:-}"

die() { echo "swarmagents-egress: ERROR: $*" >&2; exit 1; }
log() { echo "swarmagents-egress: $*"; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v iptables >/dev/null 2>&1 || die "iptables not found"

# --- Resolve the VM subnet -------------------------------------------------
if [ -z "$SUBNET" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    SUBNET="$(docker network inspect "$NETWORK" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
    if [ -n "$SUBNET" ]; then
      # Remember it for the boot path, when Docker is not up yet.
      echo "$SUBNET" > "$SUBNET_FILE"
      log "subnet $SUBNET (from docker network $NETWORK, saved to $SUBNET_FILE)"
    fi
  fi
fi
if [ -z "$SUBNET" ] && [ -f "$SUBNET_FILE" ]; then
  SUBNET="$(tr -d '[:space:]' < "$SUBNET_FILE")"
  [ -n "$SUBNET" ] && log "subnet $SUBNET (from saved $SUBNET_FILE; docker unavailable)"
fi
[ -n "$SUBNET" ] || die "cannot determine VM subnet: docker network '$NETWORK' unavailable and no saved subnet in $SUBNET_FILE (run once with docker up, or set SWARM_EGRESS_SUBNET)"
case "$SUBNET" in
  *.*.*.*/*) ;;
  *) die "subnet '$SUBNET' does not look like CIDR (expected e.g. 172.30.0.0/16)" ;;
esac

# --- Install the rules (idempotent) ---------------------------------------
# Create the chain if missing, flush any previous contents.
iptables -t mangle -N "$CHAIN" 2>/dev/null || true
iptables -t mangle -F "$CHAIN"

# DNS to the VCN resolver (metadata IP, port 53 only) stays reachable.
iptables -t mangle -A "$CHAIN" -d 169.254.169.254 -p udp --dport 53 -j RETURN
iptables -t mangle -A "$CHAIN" -d 169.254.169.254 -p tcp --dport 53 -j RETURN
# Cloud instance metadata: everything else to 169.254.169.254 is dropped.
iptables -t mangle -A "$CHAIN" -d 169.254.169.254 -j DROP
# Tailnet: the operator's own machines.
iptables -t mangle -A "$CHAIN" -d 100.64.0.0/10 -j DROP
# Private ranges: other containers, the host, host-published ports via DNAT.
iptables -t mangle -A "$CHAIN" -d 10.0.0.0/8 -j DROP
iptables -t mangle -A "$CHAIN" -d 172.16.0.0/12 -j DROP
iptables -t mangle -A "$CHAIN" -d 192.168.0.0/16 -j DROP
iptables -t mangle -A "$CHAIN" -d 169.254.0.0/16 -j DROP
# Outbound mail submission from the agent container.
for port in 25 465 587; do
  iptables -t mangle -A "$CHAIN" -p tcp --dport "$port" -j DROP
done
# Anything else (public internet) is allowed.
iptables -t mangle -A "$CHAIN" -j RETURN

# Hook the chain into PREROUTING for VM-subnet traffic only. Drop any stale
# jump first so re-runs never stack duplicate jumps.
iptables -t mangle -D PREROUTING -s "$SUBNET" -j "$CHAIN" 2>/dev/null || true
iptables -t mangle -I PREROUTING -s "$SUBNET" -j "$CHAIN"

log "egress policy active for $SUBNET: metadata/tailnet/private/SMTP blocked, public internet allowed"
