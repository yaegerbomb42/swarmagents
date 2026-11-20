# syntax=docker/dockerfile:1
FROM docker:27.5.1-cli AS docker-cli
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Bake the build timestamp into the bundle (see next.config.ts `env`): a deploy
# may pass --build-arg SWARM_BUILD_TIME=<ISO time>; otherwise stamp the image
# build time so /api/health reports a real builtAt without extra deploy config.
ARG SWARM_BUILD_TIME
RUN mkdir -p public && SWARM_BUILD_TIME=${SWARM_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)} npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3777 \
    SWARM_HOME=/data \
    SWARM_BROWSER_EXECUTABLE=/usr/bin/chromium

# docker-cli talks to the mounted host socket; Chromium backs BrowserManager;
# tar creates the numeric-ownership archive used to seed desktop VNC secrets.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        tar \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs \
    && mkdir -p /data \
    && chown nextjs:nodejs /data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# The desktop proxy is a standalone Node process (DEPLOY.md runs
# `node dist/desktop-proxy/desktop-proxy/server.js`) built by tsc from
# lib/desktop-proxy. It uses only Node built-ins and relative requires, so it
# runs in this runner image without extra dependencies.
COPY --from=builder --chown=nextjs:nodejs /app/dist/desktop-proxy ./dist/desktop-proxy

USER nextjs
EXPOSE 3777
VOLUME ["/data"]

# Readiness covers the board, free disk and (for the Docker driver) the daemon.
# Middleware lets this loopback probe through the server-mode host allowlist.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3777) + '/api/health?ready=1').then(async (r) => { const body = await r.json().catch(() => null); process.exit(r.ok && body?.ready === true ? 0 : 1); }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
