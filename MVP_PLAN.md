# dnd.firegory MVP Plan

This plan scopes the first useful version of `dnd.firegory.site`: a private D&D 5e/5.5e search/RAG site with authentication, role-based corpus access, PDF ingestion, and citation-first answers.

## MVP Outcome

A self-hosted Docker Compose deployment where:

- Users can register/login with password auth.
- Admin can assign roles: `user`, `premium`, `admin`.
- Admin can upload PDFs, set metadata, monitor ingestion, and retry/reprocess/delete failed jobs.
- CLI ingestion exists for batch/debug operations.
- Users can search/ask questions over allowed D&D content.
- Retrieval respects role, edition, language, category, and ownership filters.
- Answers are citation-first: short answer + direct quote + source.

## Explicit MVP Scope

### In scope

- Next.js/TypeScript app skeleton.
- Postgres + pgvector schema.
- Redis-backed worker queue.
- Local filesystem storage for originals and processed artifacts.
- Docker Compose dev environment.
- Login/password auth and required registration.
- Basic role management by admin.
- Categories:
  - core rules
  - official supplements
  - homebrew
- Editions:
  - 5e
  - 5.5e
- Languages:
  - English (`en`)
  - Russian (`ru`)
- Language toggle for answer/source corpus selection.
- Edition toggle.
- Hybrid retrieval foundation:
  - Postgres full-text/keyword search
  - pgvector semantic search
  - semantic query expansion hook
  - reranking hook
- z.ai integration for answer generation and/or retrieval provider calls.
- PDF ingestion with OCR-capable pipeline.
- Admin ingestion UI:
  - upload PDF
  - metadata selection
  - job status/errors
  - retry
  - reprocess
  - delete
- CLI ingestion command using the same ingestion internals where practical.
- Barebones UI: login, search form, toggles, answer/citations, admin ingestion pages.

### Out of scope for MVP

- PDF page/link preview UI.
- Bounding-box citation highlighting.
- Polished design system.
- Multi-provider LLM fallback.
- Public content sharing or social features.
- Payment/subscription automation.
- Advanced observability stack.

Data model should still preserve `fileId`, page, and optional location metadata so page preview/bbox support can be added later without re-ingesting everything.

## Milestones

### 0. Repository bootstrap

Deliverables:

- Project skeleton selected and committed.
- Package manager selected.
- README with local dev commands.
- `.env.example` with non-secret configuration names.
- Docker Compose for Postgres/Redis and app/worker placeholders.

Acceptance:

- Fresh checkout can install dependencies.
- `docker compose up` starts infrastructure services.
- Basic lint/typecheck command exists.

### 1. Database and auth foundation

Deliverables:

- Initial schema/migrations:
  - users
  - roles
  - sources
  - files
  - ingestion jobs
  - pages/documents
  - chunks with pgvector embedding column
- Password auth.
- Registration required.
- Admin-only role management path or seed script for first admin.

Acceptance:

- New user can register/login.
- Non-admin cannot access admin routes.
- Admin can view users and change roles.

### 2. Content metadata and access model

Deliverables:

- Source/file metadata CRUD for admins.
- Access tier fields:
  - open/SRD
  - shared premium
  - personal owned content
- Category, language, edition fields.
- Server-side authorization helper for retrieval filters.

Acceptance:

- `user` sees only open/SRD content.
- `premium` sees open/SRD, shared premium, and owned personal content.
- `admin` sees all content.
- Tests cover the access-filter builder.

### 3. PDF ingestion pipeline

Deliverables:

- Original PDF storage.
- Worker job lifecycle:
  - queued
  - processing
  - succeeded
  - failed
- PDF validation/normalization.
- Text extraction with page mapping.
- OCR fallback for scanned/low-text pages.
- Processed artifacts saved to storage.
- Chunking with source/page metadata.
- Embedding generation and persistence.
- CLI ingestion command.

Acceptance:

- Admin can upload a PDF and see job progress.
- A text PDF ingests successfully.
- A scanned PDF can be OCRed when dependencies are installed.
- Failed jobs expose readable errors and can be retried.
- CLI can ingest a local PDF with metadata flags.

### 4. Search and retrieval

Deliverables:

- Search API with filters:
  - role/access
  - language
  - edition
  - category
  - owner/premium scope
- Keyword search.
- Vector search.
- Hybrid candidate merge.
- Semantic expansion interface.
- Reranking interface.

Acceptance:

- Query returns relevant chunks with citations.
- Filters cannot be bypassed from client input.
- Russian and English corpora remain separate unless explicitly designed otherwise.
- Edition toggle changes the candidate corpus.

### 5. Citation-first RAG answers

Deliverables:

- z.ai server-side client.
- Prompt/template for citation-first answers.
- Answer API that returns structured citations.
- UI rendering:
  - answer
  - quote
  - source title
  - edition/language/page/section if available

Acceptance:

- Answer cites retrieved chunks.
- If retrieval confidence is low, answer says it cannot find support in the selected corpus.
- Generated answer language follows selected UI language, not necessarily query language.
- Source quotes come only from authorized selected corpus.

### 6. Admin ingestion UI polish

Deliverables:

- Admin upload form.
- Metadata controls.
- Job table with status/errors.
- Retry/reprocess/delete actions.
- Basic safeguards around destructive delete.

Acceptance:

- Admin can manage ingestion without CLI for normal use.
- Delete removes or deactivates source, chunks, and related artifacts according to the chosen deletion policy.
- Reprocess preserves original PDF and creates a new job/artifact set.

### 7. MVP hardening and deploy notes

Deliverables:

- Docker Compose dev setup documented.
- Required OCR packages documented in worker image.
- Environment variables documented.
- Basic smoke tests/checklist.
- Backup notes for Postgres and storage directory.

Acceptance:

- Fresh deployment path is documented.
- Secrets are not committed.
- Minimal smoke checklist passes:
  - login
  - admin upload
  - ingestion
  - search
  - RAG answer with citation
  - role-limited access

## Suggested Initial Schema Checklist

- `users`
- `sessions` or auth adapter tables
- `sources`
- `source_access` or access fields on `sources`
- `files`
- `ingestion_jobs`
- `pages`
- `chunks`
- `chunk_embeddings` if not embedded directly in `chunks`
- `rag_events` / `search_events` for diagnostics if cheap to add

## Environment Variables

Names only; do not commit real values:

```text
DATABASE_URL=
REDIS_URL=
APP_URL=
AUTH_SECRET=
ZAI_API_KEY=
STORAGE_ROOT=
```

Optional later:

```text
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

## Quality Gates

Before calling MVP complete:

- Typecheck passes.
- Lint passes.
- Unit tests for access filters and retrieval filter composition pass.
- At least one ingestion smoke test with a text PDF.
- At least one OCR smoke test or documented manual verification.
- Manual role-access test:
  - `user` cannot retrieve premium/personal content.
  - `premium` can retrieve allowed premium content.
  - `admin` can inspect/manage all content.

## Implementation Notes

- Treat authorization as a server-side retrieval concern, not a UI-only filter.
- Keep ingestion idempotent by file checksum and source/job identifiers where possible.
- Preserve original PDFs and processed artifacts for reprocessing/debugging.
- Store enough page/location metadata now to avoid painful migration for future PDF preview.
- Keep the first UI barebones; retrieval correctness and citations matter more than polish.
