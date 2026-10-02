# Swarm (swarmagents v2), server image for https://swarmagents.codes.
# Built ON the VPS by `infra/deploy.sh swarmagents`. It contains no secrets: the owner token and mode come
# from the server env file at runtime (see infra/docker-compose.yml, service swarmagents-dashboard).
# The agent has a full shell, so it runs as an unprivileged user. Everything it owns is in /data (a named
# volume: sessions, settings, uploads, checkpoints, and its home directory).

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Type errors fail the build, and that fails the deploy before the running container is replaced.
RUN npx tsc --noEmit && npx next build

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
# Tools the agent uses: shell is zsh, plus ripgrep, git, curl, python3, pdftotext, and headless Chromium for the
# browser tool. Chrome's own sandbox needs user namespaces, which this locked-down container doesn't grant, so
# it runs with --no-sandbox; the container (non-root, no caps, egress-filtered) is the sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends zsh bash ca-certificates curl wget git ripgrep python3 python3-pip \
      poppler-utils procps less unzip jq tini \
      chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 swarm && useradd -u 10001 -g swarm -d /data/home -s /bin/zsh -M swarm \
 && mkdir -p /data/home && chown -R swarm:swarm /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.mjs ./next.config.mjs
RUN rm -rf .next/cache && chown -R root:root /app && chmod -R a+rX /app
ENV PORT=3400 HOSTNAME=0.0.0.0 SWARM_HOME=/data HOME=/data/home SHELL=/bin/zsh \
    SWARM_CHROME_PATH=/usr/bin/chromium SWARM_BROWSER_HEADLESS=1 SWARM_BROWSER_NO_SANDBOX=1
USER swarm
EXPOSE 3400
# The healthcheck is defined in compose: GET /login with Host swarmagents.codes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3400"]
