#!/bin/sh
# Healthcheck: the noVNC web client on port 6080 must accept connections.
# websockify is supervised and only listens when the VNC backend (Xvnc on
# 5901) is up, so a TCP probe of 6080 covers the whole chain.
set -eu
port="${1:-6080}"

if [ -e /dev/tcp ]; then
  # bash: real TCP probe.
  exec 3<>/dev/tcp/127.0.0.1/"$port" || exit 1
  exec 3>&-
  exit 0
fi

# POSIX sh fallback: /proc/net/tcp lists listeners in hex; websockify typically
# binds *:6080 (00000000) or 127.0.0.1:6080 (0100007F) with state 0A (LISTEN).
hex=$(printf '%04X' "$port")
grep -E "^[[:space:]]*[0-9]+:[[:space:]]*(0100007F|00000000):${hex} " /proc/net/tcp | grep -q ' 0A '
