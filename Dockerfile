FROM node:22-bookworm-slim AS dev

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

FROM node:22-bookworm-slim AS agent-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS agent-gateway

WORKDIR /app
ENV NODE_ENV=production \
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
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["npm", "run", "agent-healthcheck"]
ENTRYPOINT ["./docker/entrypoint.prod.sh"]
CMD ["npm", "run", "agent-gateway"]

FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS production-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS production-base

WORKDIR /app
ENV NODE_ENV=production \
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

FROM production-base AS app-production

COPY --from=production-build --chown=10001:10001 /app/.next ./.next
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "scripts/app-healthcheck.mjs"]
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0"]

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
CMD ["npm", "run", "worker"]

# Preserve the application image as the default build target. Select the
# standalone gateway explicitly with --target agent-gateway.
FROM dev AS app
