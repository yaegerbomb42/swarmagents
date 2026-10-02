#!/bin/sh
# Egress policy for the swarmagents agent container ONLY (docker network "swarmagents-isolated").
# Installed on the VPS as /usr/local/sbin/swarmagents-egress.sh by `infra/deploy.sh swarmagents`. Idempotent.
#   (no args)  deploy path: read the network's subnet from docker, save it to $SUBFILE, apply.
#   --boot     swarmagents-egress.service, BEFORE docker.service starts any container: apply using the saved
#              subnet without calling docker (calling it would socket-activate docker and stall boot), so
#              there is no window after a reboot where the agent container runs unfiltered.
#
# The agent has a shell, so from its network we drop new connections to: cloud instance metadata (169.254/16;
# DNS to the VCN resolver 169.254.169.254:53 stays allowed), the tailnet (100.64/10: the owner's own machines),
# private ranges (10/8, 172.16/12, 192.168/16: other containers, the host, host-published ports) and loopback.
# Replies on connections opened TO the app (the proxy) are allowed.
#
# Why mangle/PREROUTING and not filter/DOCKER-USER: Tailscale's ts-forward chain sits ahead of DOCKER-USER in
# FORWARD and ACCEPTs anything leaving via tailscale0, so a DOCKER-USER rule never sees tailnet traffic.
# mangle PREROUTING runs before routing and before any filter chain, for this subnet only. Nothing else on the
# host is touched: one dedicated chain plus one PREROUTING jump matching this network's subnet.
set -eu
NET=swarmagents-isolated
CHAIN=SWARMAGENTS-EGRESS

SUBFILE=/etc/swarmagents-egress.subnet

if [ "${1:-}" = "--boot" ]; then
  SUB=$(cat "$SUBFILE" 2>/dev/null || true)
  [ -n "$SUB" ] || { echo "swarmagents-egress: $SUBFILE missing; run infra/deploy.sh swarmagents --egress-only" >&2; exit 1; }
else
  i=0
  until docker network inspect "$NET" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge 90 ] && { echo "swarmagents-egress: docker network $NET not available" >&2; exit 1; }
    sleep 2
  done
  SUB=$(docker network inspect "$NET" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
  [ -n "$SUB" ] || { echo "swarmagents-egress: no subnet for $NET" >&2; exit 1; }
  echo "$SUB" > "$SUBFILE"
fi
case "$SUB" in */*) ;; *) echo "swarmagents-egress: bad subnet '$SUB'" >&2; exit 1 ;; esac

# Remove the earlier filter-table version of this policy (DOCKER-USER hook), if present.
if iptables -S DOCKER-USER >/dev/null 2>&1; then
  iptables -S DOCKER-USER | grep -- "-j $CHAIN" | sed 's/^-A /-D /' | while read -r rule; do
    # shellcheck disable=SC2086
    iptables $rule || true
  done
fi
iptables -F "$CHAIN" 2>/dev/null && iptables -X "$CHAIN" 2>/dev/null || true

iptables -t mangle -N "$CHAIN" 2>/dev/null || true
iptables -t mangle -F "$CHAIN"
iptables -t mangle -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -t mangle -A "$CHAIN" -d 169.254.169.254/32 -p udp --dport 53 -j RETURN
iptables -t mangle -A "$CHAIN" -d 169.254.169.254/32 -p tcp --dport 53 -j RETURN
for net in 169.254.0.0/16 100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8; do
  iptables -t mangle -A "$CHAIN" -d "$net" -j DROP
done

# Exactly one PREROUTING jump, for the current subnet (drop stale ones if the network was ever recreated).
iptables -t mangle -S PREROUTING | grep -- "-j $CHAIN" | grep -v -- "-s $SUB " | sed 's/^-A /-D /' | while read -r rule; do
  # shellcheck disable=SC2086
  iptables -t mangle $rule || true
done
iptables -t mangle -C PREROUTING -s "$SUB" -j "$CHAIN" 2>/dev/null || iptables -t mangle -I PREROUTING 1 -s "$SUB" -j "$CHAIN"
echo "swarmagents-egress: active for $SUB (mangle/PREROUTING)"
