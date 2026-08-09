# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer survives source-only changes.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# --include=dev is explicit so the build never depends on ambient NODE_ENV —
# Coolify injects env vars as build ARGs, and a production value there would
# strip tsc and vite out of the install.
RUN npm ci --include=dev --no-audit --no-fund

COPY server ./server
COPY web ./web
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=5280 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

RUN apk add --no-cache tini \
 && addgroup -g 10001 -S srevoice \
 && adduser -u 10001 -S srevoice -G srevoice \
 && mkdir -p /data \
 && chown -R srevoice:srevoice /data

COPY --from=build --chown=srevoice:srevoice /app/node_modules ./node_modules
COPY --from=build --chown=srevoice:srevoice /app/package.json ./package.json
COPY --from=build --chown=srevoice:srevoice /app/server/package.json ./server/package.json
COPY --from=build --chown=srevoice:srevoice /app/server/dist ./server/dist
COPY --from=build --chown=srevoice:srevoice /app/web/dist ./web/dist

USER srevoice
EXPOSE 5280
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5280)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, so Coolify's stop is graceful.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
