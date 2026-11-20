#!/bin/sh
# swarm-desktop-init.sh — boot the desktop stack for a swarm-vm:desktop VM.
#
# Runs as the unprivileged `node` user (the image's USER). The driver copies
# the generated VNC password into DESKTOP_VNC_PASSWORD_FILE (0600) *before*
# the container starts, so the secret is never present in PID 1's environment
# (and therefore never readable from /proc/1/environ). A manual
# `docker run -e SWARM_VNC_PASSWORD=...` still works as a fallback.
# This script reads whichever source exists, writes the VNC password files,
# unsets the env var, then hands off to supervisord, which keeps Xvnc + XFCE +
# the noVNC web client alive.
#
# The plaintext copy in /home/node/.vnc/.swarm-vnc-password is 0600 and only
# readable by the node user; desktopEndpoint() re-reads it after a restart.

set -eu

# Resolve the VNC password: the driver-seeded 0600 file (normal case), else an
# operator-set SWARM_VNC_PASSWORD, else a random one generated here.
# A random one that the driver never saw means the web endpoint will refuse to
# connect until the container is recreated — see the README.
if [ -f /home/node/.vnc/.swarm-vnc-password ]; then
  VNC_PASSWORD="$(cat /home/node/.vnc/.swarm-vnc-password)"
elif [ -n "${SWARM_VNC_PASSWORD:-}" ]; then
  VNC_PASSWORD="$SWARM_VNC_PASSWORD"
else
  VNC_PASSWORD="$(head -c 12 /dev/urandom | base64 | tr -d '=/+' | head -c 12)"
fi

mkdir -p /home/node/.vnc
umask 077

# TigerVNC password file (vncpasswd -f obfuscates for Xvnc's -rfbauth).
printf '%s\n' "$VNC_PASSWORD" | vncpasswd -f > /home/node/.vnc/passwd
chmod 0600 /home/node/.vnc/passwd

# The driver's plaintext copy — 0600, node-owned, for desktopEndpoint() to
# re-read after a server restart.
printf '%s\n' "$VNC_PASSWORD" > /home/node/.vnc/.swarm-vnc-password
chmod 0600 /home/node/.vnc/.swarm-vnc-password

# Unset so it cannot leak into the supervised children's environments or logs.
unset SWARM_VNC_PASSWORD

exec supervisord -c /etc/supervisor/conf.d/swarm-desktop.conf
