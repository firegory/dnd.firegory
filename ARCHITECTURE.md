# dnd.firegory Architecture

Personal, self-hosted D&D 5e/5.5e search and citation-first RAG site for `dnd.firegory.site`.

## Goals

- Authenticated web app for private D&D rules/content search.
- Role-based access:
  - `user`: SRD/open content only.
  - `premium`: SRD plus shared premium pool and personal uploaded books/content.
  - `admin`: content ingestion, job management, users/roles, diagnostics.
- Bilingual UX: English/Russian UI toggle, questions accepted in either language, answer generated in selected language.
- Edition-aware retrieval: D&D 5e and 5.5e toggle.
- Citation-first answers: concise answer, direct quote, and source metadata before any broader explanation.
- Robust PDF ingestion, including OCR, with both admin UI and CLI workflows.

## Recommended Stack

- App: Next.js + TypeScript.
- Database: Postgres with `pgvector` for embeddings.
- Cache/queue: Redis + worker process.
- Storage: filesystem for MVP; MinIO-compatible abstraction when object storage becomes useful.
- PDF/OCR tooling:
  - `ocrmypdf`
  - Tesseract with `eng` and `rus`
  - `poppler-utils`
  - `qpdf`
  - Ghostscript
- LLM/RAG provider: z.ai token configured server-side only.
- Deployment target: self-hosted Docker Compose.

## High-Level Services

```text
Browser
  -> Next.js app/API
      -> Postgres + pgvector
      -> Redis queue
      -> File/object storage
      -> z.ai LLM/embedding/rerank provider

Worker
  -> Redis queue
  -> PDF/OCR tools
  -> File/object storage
  -> Postgres + pgvector
```

Canonical content publication is a separate worker-owned write path. The app fsyncs validated commands and immutable state events to a durable outbox while its canonical repository mount remains read-only, then sends uniquely identified deliveries through Redis. Ownership-checked visibility renewal coordinates queue work, while advisory locks reduce normal contention. Correctness comes from immutable fixed-width PostgreSQL fencing-token activations: the greatest valid activation is active, so a stale writer cannot regress content. Immutable revisions and activations are installed through fsynced temporary files and atomic same-filesystem renames.

### Next.js app

Responsibilities:

- Login/password auth and registration.
- Role checks and content visibility filters.
- Search/RAG API endpoints.
- Admin UI for ingestion and job management.
- Barebones MVP UI for asking questions, toggling language/edition, and viewing citations.

### Worker

Responsibilities:

- Process uploaded PDFs and batch CLI ingestion jobs.
- Normalize/extract/OCR text.
- Chunk content.
- Generate embeddings.
- Store processed artifacts and ingestion errors.
- Support retry/reprocess/delete flows.

## Content Model

Core entities for MVP:

- `users`
  - email/login, password hash, role (`user`, `premium`, `admin`), timestamps.
- `sources`
  - title, category (`core_rules`, `official_supplement`, `homebrew`), edition (`5e`, `5.5e`), language (`en`, `ru`), access tier, owner user id for personal content, metadata.
- `files`
  - original filename, storage path/key, mime type, checksum, size, source id, upload metadata.
- `ingestion_jobs`
  - status, queue id, source/file id, selected metadata, progress, error summary, logs/artifact paths.
- `documents` / `pages`
  - extracted text by page or logical section, source/file linkage.
- `chunks`
  - text, quote-safe text span, page number, section heading, source/file/page linkage, token counts, embedding vector.
- `search_events` / `rag_events` (optional early diagnostics)
  - query, filters, selected chunks, latency, provider usage.

Extensibility requirements:

- Store enough location metadata to later add PDF page/link preview:
  - `fileId`
  - page number
  - text span offsets when available
  - optional bounding boxes (`bbox`) for OCR/PDF coordinates
- Keep original PDFs and processed artifacts, not only final chunks.

## Access and Filtering

All retrieval must apply authorization before answer generation:

- Anonymous: no app access.
- `user`: only open/SRD sources.
- `premium`: open/SRD + shared premium pool + personal owned sources.
- `admin`: all sources.

Search filters always include:

- role/access tier
- selected edition (`5e`/`5.5e`)
- selected answer/source language (`en`/`ru`)
- category filter when user chooses one
- owner filter for personal premium content

## Retrieval Pipeline

Target pipeline:

1. Normalize user query.
2. Detect/accept query language, but answer in selected UI language.
3. Apply hard filters: access, edition, language, category.
4. Hybrid retrieval:
   - keyword/full-text search in Postgres
   - vector search with `pgvector`
5. Semantic expansion:
   - expand rules terms, aliases, spell names, class/features, and bilingual terms where useful
   - expansion must not bypass selected corpus/language filters
6. Reranking:
   - rerank candidate chunks by relevance, citation quality, and source priority
7. Compose citation-first context.
8. Generate answer using z.ai:
   - short direct answer
   - direct quote(s)
   - source citation(s)
   - no unsupported claims outside retrieved corpus
9. Return answer plus structured citations.

## Citation Format

MVP response should support:

- Short answer in selected language.
- One or more quotes.
- Source metadata:
  - title
  - category
  - edition
  - language
  - page/section when available
  - file id/page id internally for future preview links

Example shape:

```json
{
  "answer": "...",
  "citations": [
    {
      "quote": "...",
      "sourceTitle": "Basic Rules",
      "edition": "5e",
      "language": "en",
      "page": 42,
      "section": "Combat",
      "fileId": "..."
    }
  ]
}
```

## Ingestion Flow

Admin UI flow:

1. Admin uploads PDF.
2. Admin selects/enters metadata:
   - title
   - category
   - edition
   - language
   - access tier / shared premium / owner
3. App stores original PDF.
4. App creates ingestion job.
5. Worker processes job:
   - validate file
   - repair/normalize PDF if needed
   - extract text with page mapping
   - OCR pages with missing/low-quality text
   - create processed artifacts
   - chunk text
   - embed chunks
   - persist chunks and metadata
6. Admin UI shows status, progress, errors, and actions:
   - retry
   - reprocess
   - delete source/file/chunks

CLI ingestion remains for batch/debug and should call the same ingestion service code as the admin UI where possible.

## Storage Layout

Filesystem MVP layout can be implementation-specific, but should preserve:

```text
storage/
  originals/<sourceId>/<fileId>.pdf
  processed/<sourceId>/<jobId>/
    normalized.pdf
    text.jsonl
    pages.jsonl
    chunks.jsonl
    ocr/
    logs/
```

Do not store z.ai tokens, auth secrets, or private upload URLs in client-visible bundles.

## Docker Compose Development

Local dev should eventually include:

- `app`: Next.js app.
- `worker`: ingestion/RAG background worker.
- `postgres`: Postgres + pgvector.
- `redis`: queue/cache.
- Optional `minio`: only if object storage abstraction is introduced before deployment.

System packages for worker image:

- `ocrmypdf`
- `tesseract-ocr`
- `tesseract-ocr-eng`
- `tesseract-ocr-rus`
- `poppler-utils`
- `qpdf`
- `ghostscript`

## Non-MVP / Later

- PDF page preview and deep links.
- Bounding-box highlighted citations.
- Advanced admin analytics.
- Multiple LLM provider fallback.
- Collaborative campaign-specific content libraries.
- Public registration hardening beyond the initial private deployment needs.
