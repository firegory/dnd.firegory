# MVP Smoke Checklist

Manual and automated verification checklist for the dnd.firegory MVP.
Complete all items before declaring the MVP ready for deployment.

## Automated Tests

These run via `npm test` and must all pass:

- [ ] **Access filter tests** — `tests/access/` (retrieval-filter + access-sql)
  - User/premium/admin role access enforcement
  - SQL generation matches in-memory filter logic
  - Corpus filter combination (edition + language + category)
  - Owner-based personal content filtering

- [ ] **Auth tests** — `tests/auth/` (password + session + admin-actions)
  - Password hashing round-trip (scrypt)
  - Session token creation and hashing (SHA-256)
  - Role validation helpers (isUserRole, assertAdmin, canManageRoles)

- [ ] **Content metadata tests** — `tests/content/metadata.test.mts`
  - Source/file CRUD validation
  - Access tier normalization (open/premium/personal)

- [ ] **Ingestion tests** — `tests/ingestion/`
  - Chunking: paragraph-aware splitting with page/span metadata
  - Quality report: scoring and status levels
  - PDF extraction: per-page text extraction logic
  - Embeddings: configuration and batch support
  - Queue: Redis enqueue/dequeue contract
  - Storage: file path and checksum utilities
  - Lifecycle: source/file metadata validation, checksum

- [ ] **Retrieval tests** — `tests/retrieval/`
  - Expand: alias/bilingual/plural expansion with no false positives
  - Hybrid: RRF merge, deduplication, limit enforcement
  - Rerank: source priority, section heading match bonus
  - Pipeline: full orchestrator composition
  - Pipeline integration: access filter → SQL → expansion → merge → rerank

- [ ] **Search tests** — `tests/search/filter-enforcement.test.mts`
  - Role-based search filtering
  - Edition/language/category narrowing

- [ ] **RAG tests** — `tests/rag/`
  - Answer format: system prompt, retrieval context, LLM parsing, citation mapping
  - Answer API: input validation
  - LLM config: provider configuration
  - Answer pipeline: end-to-end format → parse → map

- [ ] **CLI tests** — `tests/cli/validate-args.test.mts`
  - Argument validation for ingestion CLI

## Quality Gates

Run these commands — all must succeed:

```bash
npm test          # All unit + integration tests pass
npm run lint      # ESLint clean
npm run typecheck # TypeScript strict mode clean
npm run build     # Next.js production build succeeds
```

## Manual Smoke Tests

These require a running instance with Docker Compose.

### 1. Authentication

- [ ] Register a new user via `/register`
- [ ] First registered user becomes admin automatically
- [ ] Login via `/login` with correct credentials → redirects to home
- [ ] Login with wrong password → shows error message
- [ ] Logout → clears session, redirects to `/login`

### 2. Role Management

- [ ] Admin can view `/admin/users`
- [ ] Admin can change user role (user ↔ premium ↔ admin)
- [ ] Cannot remove the last admin role
- [ ] Non-admin users cannot access `/admin/users`

### 3. Admin Upload & Ingestion

- [ ] Admin can access `/admin/ingestion`
- [ ] Admin can upload a PDF with metadata (title, category, edition, language, access tier)
- [ ] Job status table shows "queued" → "processing" → "succeeded"
- [ ] Failed jobs show readable error summary
- [ ] Non-admin users cannot access upload endpoint (403)

### 4. Text PDF Ingestion

- [ ] Upload a text-based PDF (not scanned)
- [ ] Verify job completes successfully
- [ ] Verify chunks are created in the database
- [ ] Verify full-text search finds content from the PDF

### 5. OCR Verification

- [ ] Upload a scanned/image-based PDF (no text layer)
- [ ] Verify OCR runs if ocrmypdf + tesseract are installed
- [ ] If OCR dependencies are missing, verify graceful failure with clear error message
- [ ] **Note:** OCR smoke test may be manual if system dependencies aren't available in test environment

### 6. Search

- [ ] Authenticated user can POST to `/api/search` with a query
- [ ] Search returns relevant chunks with source metadata
- [ ] Search respects edition filter (5e vs 5.5e)
- [ ] Search respects language filter (en vs ru)
- [ ] Search respects category filter
- [ ] Query expansion works (e.g., "AC" matches "armor class" content)

### 7. RAG Answer with Citation

- [ ] POST to `/api/answer` with a D&D rules question
- [ ] Response includes `answer`, `citations`, `confident` fields
- [ ] Citation includes `quote`, `sourceTitle`, `edition`, `page`, `section`
- [ ] Answer language matches the `answerLanguage` parameter
- [ ] When no relevant sources found, response says so explicitly (`confident: false`)

### 8. Role-Limited Access

- [ ] **User role:** search/answer returns only open/SRD content
- [ ] **Premium role:** search/answer returns open + shared premium + own personal content
- [ ] **Admin role:** search/answer returns all content
- [ ] Unauthenticated requests to `/api/search` and `/api/answer` return 401

### 9. Admin Ingestion Actions

- [ ] Admin can retry a failed job
- [ ] Admin can reprocess a source (preserves original PDF)
- [ ] Admin can delete a source (soft-delete + cleanup)
- [ ] Cannot retry a job that is not in failed/cancelled state
- [ ] Cannot reprocess a source with an active job

### 10. CLI Ingestion

```bash
npm run ingest -- \
  --pdf test.pdf \
  --title "Test Source" \
  --category core_rules \
  --edition 5e \
  --language en \
  --access open
```

- [ ] CLI creates source, file, and job records
- [ ] CLI validates required arguments
- [ ] CLI rejects invalid metadata values

## Environment Verification

Before deployment, confirm:

- [ ] `DATABASE_URL` points to Postgres with pgvector extension
- [ ] `REDIS_URL` points to running Redis instance
- [ ] `ZAI_API_KEY` is set for embedding + answer generation
- [ ] `AUTH_SECRET` is set for session token hashing
- [ ] `STORAGE_ROOT` points to writable directory with sufficient disk space
- [ ] Worker process has access to OCR tools: `ocrmypdf`, `tesseract` (eng+rus), `poppler-utils`, `qpdf`, `ghostscript`
- [ ] Docker Compose starts all services: `app`, `worker`, `postgres`, `redis`
- [ ] Secrets are NOT committed to the repository

## Pre-Deployment Checklist

- [ ] All automated tests pass (`npm test`)
- [ ] Lint clean (`npm run lint`)
- [ ] Typecheck clean (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Manual smoke checklist completed
- [ ] Environment variables documented in `.env.example`
- [ ] Backup strategy for Postgres documented (`docs/backups.md`)
- [ ] Deployment guide reviewed (`docs/deployment.md`)
