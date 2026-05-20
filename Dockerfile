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
