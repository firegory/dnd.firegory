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
- PostgreSQL 16+ with pgvector extension
- Redis 7+
- Docker and Docker Compose (for full stack, alternative)
- poppler-utils (for PDF text extraction and citation previews)

### Local development (bare metal)

1. Install system dependencies:

```bash
sudo apt-get update && sudo apt-get install -y poppler-utils
```

2. Set up PostgreSQL with pgvector and Redis. Ensure both are running.

3. Copy the environment config and edit with your values:

```bash
cp .env.example .env.local
```

Minimal `.env.local` for bare-metal:

```bash
DATABASE_URL=postgres://<user>:<password>@localhost:5432/dnd_firegory
REDIS_URL=redis://127.0.0.1:6379
LLM_API_KEY=your-llm-api-key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# Optional: use Ollama for embeddings instead of z.ai
# EMBEDDING_PROVIDER=ollama
# OLLAMA_BASE_URL=http://127.0.0.1:11434
# OLLAMA_EMBEDDING_MODEL=bge-m3
# OLLAMA_EMBEDDING_DIMENSIONS=1024
```

4. Install dependencies and run migrations:

```bash
npm install
npm run db:migrate
```

5. Start the dev server:

```bash
npm run dev
```

The app starts at http://localhost:3000. The first registered account is promoted to `admin`; later accounts start as `user`. Admins can manage roles at `/admin/users`.

To expose the dev server on your local network, start with:

```bash
npm run dev -- --hostname 0.0.0.0
```

If you access the app via a LAN IP, add it to `allowedDevOrigins` in `next.config.ts`.

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
                            → LLM provider (configurable)

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
| `--owner-user-id` | conditional | Plain UUID required for `personal`; forbidden for `open` and `premium` |
| `--help` | no | Show usage information |

### Worker system dependencies

The ingestion worker and citation preview feature depend on system PDF tools. The Docker image installs them automatically for both `app` and `worker` services.

For bare-metal Debian/Ubuntu, install at least Poppler (required for both the worker and citation previews on the app server):

```bash
sudo apt-get update && sudo apt-get install -y poppler-utils
```

Full PDF normalization and OCR support needs the complete set:

```bash
sudo apt-get update && sudo apt-get install -y \
  poppler-utils \
  qpdf \
  ghostscript \
  ocrmypdf \
  tesseract-ocr \
  tesseract-ocr-eng \
  tesseract-ocr-rus
```

- `poppler-utils` provides `pdfinfo` and `pdftotext`; these are required for text extraction, and jobs fail before extraction if they are missing.
- `qpdf` and `ghostscript` improve PDF normalization/repair.
- `ocrmypdf` plus Tesseract English/Russian data enables OCR fallback for scanned or low-text pages.

On worker startup, a preflight check logs any missing required or optional tools so deployment issues are visible before a PDF job is processed.

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
| `AUTH_SECRET` | no | Reserved for future session secret hardening |
| `ZAI_API_KEY` | yes* | z.ai API key for z.ai embeddings (*required when using z.ai as embedding provider) |
| `LLM_API_KEY` | yes* | API key for the LLM chat provider (*required for answer generation unless using a local endpoint) |
| `LLM_BASE_URL` | no | LLM API base URL (default: `https://api.openai.com/v1`) |
| `LLM_MODEL` | no | LLM model name (default: `gpt-4o-mini`) |
| `STORAGE_ROOT` | no | Root directory for file storage (default: `./storage`) |
| `DND_DATA_ROOT` | for portable content | Root of the versioned canonical content repository; see `content-repository/README.md` |
| `PUBLICATION_SPOOL_ROOT` | no | Durable app-to-worker publication command spool (default: `<STORAGE_ROOT>/publication-spool`) |
| `APP_PORT` | no | Host port for the app in Docker Compose (default: `3000`) |
| `POSTGRES_DB` | no | PostgreSQL database name (default: `dnd_firegory`) |
| `POSTGRES_USER` | no | PostgreSQL user (default: `dnd`) |
| `POSTGRES_PASSWORD` | no | PostgreSQL password (default: `dnd_dev_password`) |
| `POSTGRES_PORT` | no | Host port for PostgreSQL (default: `5432`) |
| `REDIS_PORT` | no | Host port for Redis (default: `6379`) |

**Do not commit real secrets.** The `.env` and `.env.local` files are git-ignored.

### Embedding configuration

The system supports separate embedding providers for ingestion (batch embeddings during PDF upload) and query (embedding search queries for vector retrieval). If the specific config is not set, it falls back to the generic embedding config.

**Why split?** In a typical deployment:
- The **ingestion worker** runs where you do PDF processing — often on a development PC with a powerful GPU for fast batch embedding.
- The **query vector search** runs on the deploy server — a lightweight local Ollama instance for low-latency query embedding.
- Both must use the same model and dimensions so embeddings are compatible.

| Variable | Default | Description |
| --- | --- | --- |
| `EMBEDDING_PROVIDER` | `zai` | Generic embedding provider: `zai` or `ollama` |
| `EMBEDDING_DIMENSIONS` | provider default | Generic embedding vector dimensions override |

#### z.ai embedding (generic fallback)

| Variable | Default | Description |
| --- | --- | --- |
| `ZAI_EMBEDDING_BASE_URL` | z.ai default | z.ai embedding API base URL |
| `ZAI_EMBEDDING_MODEL` | `z-embedding` | z.ai embedding model name |
| `ZAI_EMBEDDING_DIMENSIONS` | `1024` | z.ai embedding vector dimensions |

#### Ollama embedding (generic fallback)

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API base URL |
| `OLLAMA_EMBEDDING_MODEL` | `bge-m3` | Ollama embedding model name |
| `OLLAMA_EMBEDDING_DIMENSIONS` | `1024` | Ollama embedding vector dimensions |
| `OLLAMA_KEEP_ALIVE` | `1m` | Ollama model residency after a request; set `0` to unload immediately |

#### Ingestion embedding (worker/pipeline)

Overrides for the ingestion worker. Falls back to generic config if not set.

| Variable | Default | Description |
| --- | --- | --- |
| `INGESTION_EMBEDDING_PROVIDER` | generic fallback | Provider for batch embeddings during ingestion |
| `INGESTION_OLLAMA_BASE_URL` | `OLLAMA_BASE_URL` | Ollama URL for ingestion (e.g. remote PC) |
| `INGESTION_OLLAMA_EMBEDDING_MODEL` | `OLLAMA_EMBEDDING_MODEL` | Model name for ingestion |
| `INGESTION_OLLAMA_EMBEDDING_DIMENSIONS` | `OLLAMA_EMBEDDING_DIMENSIONS` | Dimensions for ingestion |
| `INGESTION_OLLAMA_KEEP_ALIVE` | `OLLAMA_KEEP_ALIVE` | Keep-alive for ingestion Ollama |

#### Query embedding (vector search)

Overrides for vector search. Falls back to generic config if not set.

| Variable | Default | Description |
| --- | --- | --- |
| `QUERY_EMBEDDING_PROVIDER` | generic fallback | Provider for query-time embeddings |
| `QUERY_OLLAMA_BASE_URL` | `OLLAMA_BASE_URL` | Ollama URL for search (e.g. localhost on server) |
| `QUERY_OLLAMA_EMBEDDING_MODEL` | `OLLAMA_EMBEDDING_MODEL` | Model name for search |
| `QUERY_OLLAMA_EMBEDDING_DIMENSIONS` | `OLLAMA_EMBEDDING_DIMENSIONS` | Dimensions for search |
| `QUERY_OLLAMA_KEEP_ALIVE` | `OLLAMA_KEEP_ALIVE` | Keep-alive for search Ollama |

### Example `.env.local` for Ollama deployment

```bash
# LLM (self-hosted OpenAI-compatible)
LLM_API_KEY=
LLM_BASE_URL=http://192.168.0.10:11434/v1
LLM_MODEL=qwen3.6-q8

# Embedding: Ollama
EMBEDDING_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
OLLAMA_EMBEDDING_DIMENSIONS=1024

# Ingestion uses remote Ollama on developer's PC
INGESTION_EMBEDDING_PROVIDER=ollama
INGESTION_OLLAMA_BASE_URL=http://192.168.0.101:11434

# Query uses local Ollama on the deploy server
QUERY_EMBEDDING_PROVIDER=ollama
QUERY_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

### Installing Ollama for embeddings

1. Install Ollama: follow [ollama.com/download](https://ollama.com/download) or run:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

2. Pull the embedding model:

```bash
ollama pull bge-m3
```

3. Set the env vars in `.env.local`:

```bash
EMBEDDING_PROVIDER=ollama
```

4. Verify Ollama is running and the model is available:

```bash
curl http://127.0.0.1:11434/api/embed \
  -d '{"model":"bge-m3","input":"test"}'
```

**Note:** Both ingestion and query must use the same model and dimensions for compatible embeddings.

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
│   │   ├── embeddings/         # Embedding provider (z.ai / Ollama)
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
