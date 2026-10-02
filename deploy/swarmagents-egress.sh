#!/bin/sh
# Egress policy for the swarmagents agent container ONLY (docker network "swarmagents-isolated").
# Installed on the VPS as /usr/local/sbin/swarmagents-egress.sh by `infra/deploy.sh swarmagents`, and run at
# boot by swarmagents-egress.service (after docker). Idempotent.
#
# The agent has a shell, so from its network we block: cloud instance metadata (169.254/16; DNS to the VCN
# resolver 169.254.169.254:53 stays allowed), the tailnet (100.64/10: the owner's own machines), and private
# ranges (10/8, 172.16/12, 192.168/16: other containers and host-published ports reached via DNAT).
# Replies to inbound connections (the proxy talking to the app) are allowed. Nothing else on the host is
# touched: one dedicated chain, and one DOCKER-USER jump that matches this network's subnet only.
set -eu
NET=swarmagents-isolated
CHAIN=SWARMAGENTS-EGRESS

# At boot, wait for docker and its DOCKER-USER chain.
i=0
until docker network inspect "$NET" >/dev/null 2>&1 && iptables -S DOCKER-USER >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -ge 90 ] && { echo "swarmagents-egress: docker network $NET not available" >&2; exit 1; }
  sleep 2
done
SUB=$(docker network inspect "$NET" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
[ -n "$SUB" ] || { echo "swarmagents-egress: no subnet for $NET" >&2; exit 1; }

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$CHAIN" -d 169.254.169.254/32 -p udp --dport 53 -j RETURN
iptables -A "$CHAIN" -d 169.254.169.254/32 -p tcp --dport 53 -j RETURN
for net in 169.254.0.0/16 100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  iptables -A "$CHAIN" -d "$net" -j REJECT
done

# Exactly one jump, for the current subnet (drop stale ones if the network was ever recreated).
iptables -S DOCKER-USER | grep -- "-j $CHAIN" | grep -v -- "-s $SUB " | sed 's/^-A /-D /' | while read -r rule; do
  # shellcheck disable=SC2086
  iptables $rule || true
done
iptables -C DOCKER-USER -s "$SUB" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -s "$SUB" -j "$CHAIN"
echo "swarmagents-egress: active for $SUB"
