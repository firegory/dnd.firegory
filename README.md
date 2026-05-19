# dnd.firegory

Private, self-hosted D&D 5e/5.5e search and citation-first RAG site for `dnd.firegory.site`.

## What is this

**dnd.firegory** is a personal web application for searching D&D rules and content with citation-backed answers. It combines hybrid retrieval (keyword + vector search) with a role-based access model so different users see different content tiers.

Key features:

- **Password authentication** with role-based access (`user`, `premium`, `admin`).
- **PDF ingestion** with OCR support — upload via admin UI or CLI.
- **Hybrid search** — keyword full-text + pgvector semantic retrieval with query expansion and reranking.
- **Citation-first RAG answers** — short answer, direct quote, source metadata.
- **Bilingual** — English and Russian content support, language toggle.
- **Edition-aware** — D&D 5e and 5.5e toggle.
- **Docker Compose** self-hosted deployment.

## Quick start

### Prerequisites

- Node.js 22+
- Docker and Docker Compose (for full stack)
- PostgreSQL 16+ with pgvector (or use the Docker stack)

### Local development (bare metal)

```bash
npm install
npm run dev
```

The app starts at http://localhost:3000. Run database migrations before registering or signing in:

```bash
export DATABASE_URL="postgres://dnd:dnd_dev_password@localhost:5432/dnd_firegory"
npm run db:migrate
npm run dev
```

The first registered account is promoted to `admin`; later accounts start as `user`. Admins can manage roles at `/admin/users`.

### Docker Compose (full stack)

```bash
cp .env.example .env
# Edit .env with your values
docker compose up --build
```

This starts:

| Service | Description | Default port |
| --- | --- | --- |
| `app` | Next.js application | 3000 |
| `worker` | Ingestion background worker | — |
| `postgres` | PostgreSQL 16 + pgvector | 5432 |
| `redis` | Queue and cache | 6379 |

See [docs/deployment.md](docs/deployment.md) for the full deployment guide.

## Architecture

```
Browser → Next.js app/API → Postgres (pgvector)
                            → Redis queue
                            → File storage
                            → z.ai LLM/embedding/rerank

Worker  → Redis queue → PDF/OCR tools → Postgres → File storage
```

- **Next.js app**: Auth, search/RAG endpoints, admin ingestion UI, barebones search UI.
- **Worker**: Processes PDF ingestion jobs from the Redis queue — normalize, extract text, OCR, chunk, embed, persist.
- **Postgres**: All persistent data with pgvector for embeddings and full-text search indexes.
- **Redis**: Job queue for ingestion tasks.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architecture document and [MVP_PLAN.md](MVP_PLAN.md) for the implementation plan.

## Access model

| Role | Content access |
| --- | --- |
| `user` | Open/SRD content only |
| `premium` | Open/SRD + shared premium pool + personal owned content |
| `admin` | All sources; can manage ingestion, users, and roles |

Access is enforced server-side in all search and retrieval queries.

## Content categories

| Field | Values |
| --- | --- |
| Category | `core_rules`, `official_supplement`, `homebrew` |
| Edition | `5e`, `5.5e` |
| Language | `en`, `ru` |
| Access tier | `open`, `premium`, `personal` |

## Ingestion

### Admin UI

Navigate to `/admin/ingestion` to upload PDFs, set metadata, and monitor job status.

### CLI

```bash
npm run ingest -- \
  --pdf path/to/book.pdf \
  --title "Player's Handbook" \
  --category core_rules \
  --edition 5e \
  --language en \
  --access open
```

| Option | Required | Description |
| --- | --- | --- |
| `--pdf` | yes | Path to a local PDF file |
| `--title` | yes | Source title |
| `--category` | yes | `core_rules`, `official_supplement`, or `homebrew` |
| `--edition` | yes | `5e` or `5.5e` |
| `--language` | yes | `en` or `ru` |
| `--access` | yes | `open`, `premium`, or `personal` |
| `--owner-user-id` | no | Owner user ID for personal content |
| `--help` | no | Show usage information |

### Worker system dependencies

The ingestion worker requires these system packages for full PDF/OCR support:

- `ocrmypdf`
- `tesseract-ocr` with `eng` and `rus` language data
- `poppler-utils`
- `qpdf`
- `ghostscript`

If these tools are missing, the pipeline continues with graceful degradation — OCR is skipped and quality reports reflect the limitations.

## API reference

All API endpoints require authentication via session cookie unless noted.

See [docs/api.md](docs/api.md) for the full endpoint reference covering search, admin ingestion, and content metadata CRUD.

## Configuration

Copy `.env.example` to `.env.local` (for `npm run dev`) or `.env` (for Docker Compose):

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `APP_URL` | no | Public app URL (default: `http://localhost:3000`) |
| `NEXT_PUBLIC_APP_URL` | no | Public app URL exposed to the browser |
| `AUTH_SECRET` | yes | Secret for session token generation |
| `ZAI_API_KEY` | no | z.ai API key for embeddings and LLM calls |
| `STORAGE_ROOT` | no | Root directory for file storage (default: `./storage`) |
| `APP_PORT` | no | Host port for the app in Docker Compose (default: `3000`) |
| `POSTGRES_DB` | no | PostgreSQL database name (default: `dnd_firegory`) |
| `POSTGRES_USER` | no | PostgreSQL user (default: `dnd`) |
| `POSTGRES_PASSWORD` | no | PostgreSQL password (default: `dnd_dev_password`) |
| `POSTGRES_PORT` | no | Host port for PostgreSQL (default: `5432`) |
| `REDIS_PORT` | no | Host port for Redis (default: `6379`) |

**Do not commit real secrets.** The `.env` and `.env.local` files are git-ignored.

### Embedding configuration

Optional environment variables for fine-tuning the embedding provider:

| Variable | Default | Description |
| --- | --- | --- |
| `ZAI_EMBEDDING_BASE_URL` | z.ai default | Embedding API base URL |
| `ZAI_EMBEDDING_MODEL` | `z-embedding` | Embedding model name |
| `ZAI_EMBEDDING_DIMENSIONS` | `1024` | Embedding vector dimensions |

## Storage layout

```
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

- **Originals**: Untouched uploaded PDFs, stored by source and file UUID.
- **Processed**: Per-job artifacts including normalized PDFs, extracted text, OCR output, and chunk data.

## Database

The MVP uses plain SQL migrations in `migrations/` with a small Node runner. Schema includes tables for users, sessions, sources, files, ingestion jobs, documents, pages, chunks (with pgvector embeddings), and diagnostic events.

Run migrations:

```bash
export DATABASE_URL="postgres://dnd:dnd_dev_password@localhost:5432/dnd_firegory"
npm run db:migrate
```

Inside the Compose network, the connection string uses the `postgres` hostname:

```
postgres://dnd:dnd_dev_password@postgres:5432/dnd_firegory
```

Migrations are idempotent — applied files are tracked in `schema_migrations`.

## Developer commands

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript type checking
npm run build       # Production build
npm start           # Start production server
npm test            # Run test suite
npm run db:migrate  # Run database migrations
npm run ingest      # CLI ingestion
```

## Backups

See [docs/backups.md](docs/backups.md) for backup and restore procedures for PostgreSQL data and file storage.

## Project structure

```
dnd.firegory/
├── src/
│   ├── app/                    # Next.js App Router pages and API routes
│   │   ├── admin/ingestion/    # Admin upload UI, job status table
│   │   ├── admin/users/        # Admin user management
│   │   ├── api/
│   │   │   ├── admin/          # Admin API: sources, files, ingestion
│   │   │   └── search/         # Search endpoint
│   │   ├── login/              # Login page
│   │   └── register/           # Registration page
│   ├── cli/                    # CLI argument validation
│   ├── middleware.ts           # Route protection middleware
│   ├── server/
│   │   ├── access/             # Access filter builder, retrieval authorization
│   │   ├── admin/              # Admin context resolver
│   │   ├── auth/               # Password hashing, sessions, user management
│   │   ├── content/            # Source and file metadata CRUD
│   │   ├── db/                 # Database client and migration runner
│   │   ├── embeddings/         # Embedding provider (z.ai API)
│   │   ├── ingestion/          # Storage, queue, lifecycle, actions
│   │   ├── retrieval/          # Hybrid retrieval: keyword, vector, expand, rerank
│   │   └── search/             # Search service
│   └── worker/
│       ├── index.ts            # Worker entry point
│       └── ingestion/          # PDF normalize, extract, OCR, chunk, pipeline
├── tests/                      # Test files
├── migrations/                 # SQL migrations
├── scripts/                    # CLI ingestion and migration scripts
├── docker/                     # Docker init scripts and entrypoints
├── docs/                       # Documentation
├── ARCHITECTURE.md             # Architecture document
├── MVP_PLAN.md                 # Implementation plan
└── docker-compose.yml          # Development Docker Compose
```

## Dependency notes

`package.json` includes an npm `overrides.postcss` entry so `npm audit --omit=dev` resolves to zero known production vulnerabilities while Next.js still depends on a vulnerable PostCSS range.

## License

Private repository. All rights reserved.
