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
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["npm", "run", "agent-healthcheck"]
CMD ["npm", "run", "agent-gateway"]

# Preserve the application image as the default build target. Select the
# standalone gateway explicitly with --target agent-gateway.
FROM dev AS app
