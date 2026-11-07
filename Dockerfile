FROM node:22.23.4-bookworm-slim

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Solara Docker Multi-User" \
      org.opencontainers.image.source="https://github.com/admintors/Solara" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV APP_ENV=production \
    NODE_ENV=production \
    DATA_DIR=/data \
    DB_PATH=/data/solara-multiuser.db

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node . /app
COPY --chown=node:node functions/proxy.ts /app/server/internal-proxy/functions/proxy.ts

RUN npm ci --prefix /app/server --omit=dev --ignore-scripts \
 && npm ci --prefix /app/server/internal-proxy --omit=dev \
 && mkdir -p /data /app/server/internal-proxy/public \
 && rm -f /app/functions/_middleware.ts /app/functions/api/login.ts /app/functions/api/storage.ts /app/functions/palette.ts /app/functions/proxy.ts \
 && (rmdir /app/functions/api 2>/dev/null || true) \
 && chmod 0755 /app/docker-entrypoint.sh \
 && chown -R node:node /app/server/internal-proxy /data \
 && npm cache clean --force

USER node:node
EXPOSE 8787
ENTRYPOINT ["tini", "-g", "--", "/app/docker-entrypoint.sh"]
