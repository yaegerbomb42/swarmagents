FROM node:22-alpine AS base

# ── Omnexx engine bridge: bundle packages/engine into one ESM file ─────────────
FROM base AS engine
WORKDIR /repo
COPY packages/engine/package.json packages/engine/package-lock.json packages/engine/
RUN cd packages/engine && npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
COPY packages/providers/ packages/providers/
COPY packages/engine/ packages/engine/
RUN cd packages/engine && npm run build:bridge

# ── Web control plane ────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json* apps/web/.npmrc ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV OMNEXX_BRIDGE_PATH=/app/engine/bridge.mjs

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=engine --chown=nextjs:nodejs /repo/packages/engine/dist/bridge.mjs ./engine/bridge.mjs

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
