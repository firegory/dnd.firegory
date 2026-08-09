ARG NODE_IMAGE=node:22.22.3-bookworm-slim
ARG REDIS_IMAGE=redis:7.4.5-alpine

FROM ${NODE_IMAGE} AS dev

WORKDIR /app

# PDF ingestion worker dependencies:
# - poppler-utils: pdfinfo/pdftotext (required for text extraction)
# - qpdf/ghostscript: PDF normalization and repair
# - ocrmypdf/tesseract: OCR fallback for scanned PDFs, with English/Russian data
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ghostscript \
    ocrmypdf \
    poppler-utils \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-rus \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Compose bind-mounts the working tree over /app for live development.
# Keep this copy so the image can still be inspected or run outside Compose.
COPY . .

EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]

FROM ${NODE_IMAGE} AS agent-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS agent-gateway

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    AGENT_GATEWAY_HOST=127.0.0.1
COPY --from=agent-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY scripts/agent-gateway.mts scripts/agent-healthcheck.mts ./scripts/
COPY src/server/agent ./src/server/agent
COPY src/server/access ./src/server/access
COPY src/server/auth/types.ts src/server/auth/session-token.ts ./src/server/auth/
COPY docker/entrypoint.prod.sh ./docker/entrypoint.prod.sh
USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "--experimental-strip-types", "scripts/agent-healthcheck.mts"]
ENTRYPOINT ["./docker/entrypoint.prod.sh"]
CMD ["node", "--experimental-strip-types", "scripts/agent-gateway.mts"]

FROM ${NODE_IMAGE} AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS production-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS production-base

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    STORAGE_ROOT=/app/storage \
    PUBLICATION_SPOOL_ROOT=/app/storage/publication-spool
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=10001:10001 package.json package-lock.json ./
COPY --chown=10001:10001 docker/entrypoint.prod.sh ./docker/entrypoint.prod.sh
COPY --chown=10001:10001 migrations ./migrations
COPY --chown=10001:10001 scripts ./scripts
COPY --chown=10001:10001 src ./src
# A fresh local spool volume inherits this mode. Canonical NFS access remains
# governed by the configured numeric UID/GID and host export permissions.
RUN mkdir -p /app/storage && chmod 0777 /app/storage
USER 10001:10001
ENTRYPOINT ["./docker/entrypoint.prod.sh"]

FROM production-base AS migration-production

CMD ["node", "--experimental-strip-types", "scripts/migrate.mts"]

FROM ${NODE_IMAGE} AS app-production

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && command -v pdfinfo \
  && command -v pdftoppm \
  && command -v pdftocairo \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOME=/tmp \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    STORAGE_ROOT=/app/storage \
    PUBLICATION_SPOOL_ROOT=/app/storage/publication-spool
COPY --from=production-build --chown=10001:10001 /app/.next/standalone ./
COPY --from=production-build --chown=10001:10001 /app/.next/static ./.next/static
COPY --chown=10001:10001 docker/entrypoint.prod.sh ./docker/entrypoint.prod.sh
COPY --chown=10001:10001 scripts/app-healthcheck.mjs ./scripts/app-healthcheck.mjs
RUN mkdir -p /app/storage && chmod 0777 /app/storage
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "scripts/app-healthcheck.mjs"]
ENTRYPOINT ["./docker/entrypoint.prod.sh"]
CMD ["node", "server.js"]

FROM production-base AS worker-production

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ghostscript \
    ocrmypdf \
    poppler-utils \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-rus \
  && rm -rf /var/lib/apt/lists/*
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "scripts/worker-healthcheck.mjs"]
CMD ["node", "--experimental-strip-types", "src/worker/index.ts"]

FROM ${REDIS_IMAGE} AS redis-production

COPY --chown=redis:redis docker/redis-entrypoint.sh /usr/local/bin/redis-secure-entrypoint.sh
USER redis
ENTRYPOINT ["/usr/local/bin/redis-secure-entrypoint.sh"]
CMD ["redis-server", "/run/redis/redis.conf"]

# Preserve the application image as the default build target. Select the
# standalone gateway explicitly with --target agent-gateway.
FROM dev AS app
