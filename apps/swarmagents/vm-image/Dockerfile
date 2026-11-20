# syntax=docker/dockerfile:1
#
# Per-user agent VM image ("swarm-vm:claude").
#
# This is the image the Docker VM driver creates one container from, per user.
# It used to be built by hand on the VPS; this file makes it reproducible
# from the repo:
#
#   npm run vm-image:build        # docker build -t swarm-vm:claude vm-image
#
# The image is a plain dev box: node + git + ripgrep + python + the standard
# CLI tools Claude Code expects to find, plus the Claude Code CLI itself so
# `claude -p` can run headless inside the VM.
FROM node:22-bookworm-slim

# Pinned Claude Code CLI version. Bump it deliberately (and rebuild the
# image) instead of tracking "latest".
ARG CLAUDE_CODE_VERSION=2.1.322
ARG UV_VERSION=0.9.9

LABEL org.opencontainers.image.title="swarm-vm:claude" \
      org.opencontainers.image.description="Per-user agent VM image for SwarmAgents (Docker VM driver)" \
      org.opencontainers.image.source="apps/swarmagents/vm-image"

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Standard agent tooling. ripgrep and git are what Claude Code shells out to;
# build-essential/python3-pip cover "install a package" workflows; the rest
# is the small set of CLI tools an agent expects to have.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        chromium \
        curl \
        git \
        jq \
        less \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        unzip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages "uv==${UV_VERSION}" \
    && uv --version \
    && uvx --version

RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@playwright/mcp@0.0.85" \
    && npm cache clean --force \
    && npm ls -g --depth=0 @anthropic-ai/claude-code @playwright/mcp \
    && (claude --version || echo "warning: 'claude --version' failed in the build" >&2) \
    && playwright-mcp --version

# Managed (admin-owned) Claude Code settings + the synchronous approval hook.
#
# The hook is a PreToolUse hook: Claude Code runs it before every tool call and
# blocks until it exits. It forwards the call to the harness inside the app and
# returns allow/deny, so the classifier and the user's approval card are
# synchronous with execution — nothing runs before the verdict. The hook
# authenticates with the per-run token the harness passes in the exec env
# (SWARM_APPROVAL_URL / SWARM_APPROVAL_TOKEN). It fails closed when that
# channel is unavailable.
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY hooks/pre-tool-use.mjs /usr/local/bin/swarm-approval-hook
RUN chmod 0555 /usr/local/bin/swarm-approval-hook \
    && chmod 0444 /etc/claude-code/managed-settings.json \
    && chown root:root /usr/local/bin/swarm-approval-hook /etc/claude-code/managed-settings.json

# The driver mounts a per-user named volume at /workspace; docker seeds a
# fresh named volume from the image's directory, so /workspace must be owned
# by the unprivileged `node` user (uid 1000) that ships with the base image.
RUN mkdir -p /workspace \
    && chown node:node /workspace \
    && chmod 0775 /workspace

USER node
WORKDIR /workspace

# The driver overrides the command with `tail -f /dev/null` (the container is
# long-lived and driven through `docker exec`); this is only the fallback for
# `docker run` without a command.
CMD ["tail", "-f", "/dev/null"]
