# syntax=docker/dockerfile:1
#
# Per-user desktop VM image ("swarm-vm:desktop").
#
# This is the image the Docker VM driver creates one container from, per user,
# when desktop mode is on (SWARM_VM_DESKTOP=1). It builds on the headless
# `swarm-vm:claude` image (apps/swarmagents/vm-image) and adds a full desktop:
# XFCE on X server (display :1), a browser-viewable VNC web client on the
# container's port 6080, Chromium, and the GUI/automation utilities the agent
# needs.
#
#   npm run vm-image-desktop:build   # docker build -t swarm-vm:desktop vm-image-desktop
#
# Base image choice: we build on the headless swarm-vm:claude image instead of
# pulling a third-party desktop-in-a-container base (lscr.io/linuxserver/
# webtop:debian-xfce, kasmweb/core-debian-bookworm, ...). Reasons, in order:
#
# 1. The agent stack is already there: node 22, the Claude Code CLI (pinned),
#    and the standard tooling — no duplicated layers, one source of truth.
# 2. The desktop stack comes from Debian's own archive (xfce4, tigervnc,
#    novnc, websockify, chromium, supervisor), which guarantees
#    arm64 + amd64 builds and keeps the image lean compared to webtop (which
#    bundles a full browser stack plus its own KasmVNC fork) or kasmweb
#    (built for the Kasm registry toolchain, heavier, and tied to their
#    platform conventions).
# 3. The VNC web client is noVNC + websockify (Debian packages): it serves a
#    plain-HTTP + WebSocket client on port 6080 — exactly the shape the
#    desktop-VM contract calls for — with a per-container password. The VNC
#    backend is TigerVNC's Xvnc, which is at once the X server (display :1)
#    and the VNC server, so there is no separate Xvfb/11vnc layer to keep in
#    sync.
#
# The container is driven through `docker exec` like the headless image; it
# also runs a supervisor (supervisord) that keeps the desktop + VNC client
# alive. The driver never publishes port 6080 to a host port — the browser
# reaches it over the docker network only.

FROM swarm-vm:claude

LABEL org.opencontainers.image.title="swarm-vm:desktop" \
      org.opencontainers.image.description="Per-user desktop VM image for SwarmAgents (Docker VM driver)" \
      org.opencontainers.image.source="apps/swarmagents/vm-image-desktop"

# The desktop runs on display :1 (the driver passes DISPLAY=:1); Chromium's
# user-data dir lives on the /workspace named volume so authenticated
# sessions survive hibernation and container recreation. It must be owned
# by the node user (see README: /workspace is node-owned, as in the
# headless image).
ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    CHROMIUM_USER_DATA_DIR=/workspace/.swarm/browser-profile

USER root

# Desktop packages, all from the Debian archive so the build is reproducible
# on arm64 and amd64 alike:
#   - tigervnc-standalone-server: Xvnc — the X server AND the VNC server for
#     display :1 in one process.
#   - novnc + websockify: the browser-viewable noVNC web client (port 6080).
#   - xfce4, xfce4-terminal, thunar: the desktop, its terminal and file manager.
#   - xdotool, xclip, scrot, wmctrl: GUI automation / screenshots.
#   - fonts-noto*: Noto + emoji fonts.
#   - chromium: the browser. Launched with container-safe flags (see README).
#   - supervisor: supervises the desktop stack inside the container.
#   - dbus-x11, xauth, x11-xserver-utils: XFCE session plumbing.
#   - general-purpose GUI apps for user tasks:
#       - libreoffice: office suite (writer, calc, impress)
#       - gimp: image editing
#       - blender: 3D creation
#       - poppler-utils: PDF tools (pdftotext, pdfimages)
#       - ffmpeg: audio/video processing
#       - python3-tk: Python with Tkinter GUI support
#       - python3-matplotlib: Python plotting library
#   - at-spi2-core, libatk-adaptor, python3-pyatspi: the AT-SPI2 accessibility
#     bus + GTK bridge + python bindings behind computer-mcp's inspect_ui and
#     the widget section of describe_screen (roles, names, states, centers).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tigervnc-standalone-server \
        tigervnc-tools \
        novnc \
        websockify \
        xfce4 \
        xfce4-terminal \
        thunar \
        x11-xserver-utils \
        xdotool \
        xclip \
        scrot \
        tesseract-ocr \
        imagemagick \
        wmctrl \
        fonts-noto \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        supervisor \
        chromium \
        dbus-x11 \
        xauth \
        libreoffice \
        gimp \
        blender \
        poppler-utils \
        ffmpeg \
        python3-tk \
        python3-matplotlib \
        at-spi2-core \
        libatk-adaptor \
        python3-pyatspi \
    && rm -rf /var/lib/apt/lists/*

# Desktop init: reads the driver-seeded 0600 VNC password file (or the manual
# SWARM_VNC_PASSWORD fallback), writes the VNC password files, then hands off
# to supervisord, which supervises Xvnc + XFCE + the noVNC web client.
COPY files/init.sh /usr/local/bin/swarm-desktop-init.sh
COPY files/supervisord.conf /etc/supervisor/conf.d/swarm-desktop.conf
COPY files/healthcheck.sh /usr/local/bin/swarm-desktop-healthcheck.sh
RUN chmod +x /usr/local/bin/swarm-desktop-init.sh /usr/local/bin/swarm-desktop-healthcheck.sh \
    && mkdir -p /home/node/.vnc \
    && chown node:node /home/node/.vnc \
    && chmod 0700 /home/node/.vnc

# Chromium gets a launcher wrapper (container-safe flags — see README) used by
# both the desktop shortcut and the XFCE autostart entry.
COPY files/chromium-launch.sh /usr/local/bin/swarm-chromium-launch.sh
COPY files/chromium.desktop /home/node/Desktop/chromium.desktop
COPY files/autostart.desktop /etc/xdg/autostart/swarm-desktop-autostart.desktop
RUN chmod +x /usr/local/bin/swarm-chromium-launch.sh \
    && chown node:node /home/node/Desktop/chromium.desktop \
    && chmod 0755 /home/node/Desktop/chromium.desktop

# The VNC web client listens on port 6080 inside the container; the driver
# never publishes it to a host port.
EXPOSE 6080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/swarm-desktop-healthcheck.sh", "6080"]

# Pinned Playwright MCP — the agent's desktop browser driver (drives the same
# visible Chromium on DISPLAY=:1). The app pins this exact version; bump
# deliberately and rebuild the image.
RUN npm install -g "@playwright/mcp@0.0.85" \
    && npm cache clean --force \
    && npm ls -g --depth=0 @playwright/mcp

# The computer-use MCP server source (stdio only, no network listener). The
# harness's role MCP wiring spawns it as `node /opt/swarm/computer-mcp/server.mjs`.
COPY computer-mcp /opt/swarm/computer-mcp
RUN cd /opt/swarm/computer-mcp \
    && npm install --omit=dev \
    && chown -R root:root /opt/swarm/computer-mcp \
    && chmod -R a+rX /opt/swarm/computer-mcp

USER node
WORKDIR /workspace

# The driver sets no command in desktop mode, so the image's own CMD starts
# the desktop stack (password setup -> supervisord).
CMD ["/usr/local/bin/swarm-desktop-init.sh"]
