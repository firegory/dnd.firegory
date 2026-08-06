# Deployment Guide

This guide covers deploying dnd.firegory using Docker Compose for a self-hosted private instance.

## Prerequisites

- A server with Docker and Docker Compose installed.
- At least 2 GB RAM (4 GB recommended for OCR-heavy workloads).
- Sufficient disk space for PostgreSQL data, Redis, and file storage.
- Network access to the z.ai API (for embeddings and LLM features).
- PostgreSQL 16 built with ICU and the deterministic root collation `und-x-icu` (provided by the Compose image).

## Step 1: Clone the repository

```bash
git clone https://github.com/firegory/dnd.firegory.git
cd dnd.firegory
```

## Step 2: Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your deployment values:

```bash
# Required
DATABASE_URL=postgres://dnd:your_secure_password@postgres:5432/dnd_firegory
REDIS_URL=redis://redis:6379
AUTH_SECRET=your-random-secret-at-least-32-chars  # reserved for future use
ZAI_API_KEY=your-zai-api-key

# LLM (answer generation)
LLM_API_KEY=your-llm-api-key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# App URLs
APP_URL=https://dnd.firegory.site
NEXT_PUBLIC_APP_URL=https://dnd.firegory.site

# Storage
STORAGE_ROOT=/app/storage
DND_DATA_ROOT=/app/content-repository
PUBLICATION_SPOOL_ROOT=/app/storage/publication-spool

# PostgreSQL (Compose internal)
POSTGRES_DB=dnd_firegory
POSTGRES_USER=dnd
POSTGRES_PASSWORD=your_secure_password

# Port overrides (host-side)
APP_PORT=3000
POSTGRES_PORT=5432
REDIS_PORT=6379
```

### Security notes

- Generate `AUTH_SECRET` with a cryptographically random value: `openssl rand -hex 32`. This variable is reserved for future session hardening.
- Use a strong `POSTGRES_PASSWORD` — not the development default.
- If exposing Redis on a network interface, configure Redis authentication. The development Compose file runs Redis unauthenticated.
- Never commit `.env` to version control.

## Step 3: Start services

```bash
docker compose up -d --build
```

This starts four services:

| Service | Description | Internal port |
| --- | --- | --- |
| `app` | Next.js web application | 3000 |
| `worker` | Background ingestion worker | — |
| `postgres` | PostgreSQL 16 + pgvector | 5432 |
| `redis` | Job queue and cache | 6379 |

The first start initializes the PostgreSQL database with the pgvector extension.

## Step 4: Run migrations

```bash
docker compose exec app npm run db:migrate
```

This creates the schema tables and indexes. Migrations are idempotent — re-running is safe.
The compendium migration fails clearly if PostgreSQL is not UTF-8 or lacks the deterministic ICU root collation `und-x-icu`; verify custom PostgreSQL builds before upgrading.

## Step 5: Create the first admin user

Open `https://your-domain/register` in a browser and create an account. The **first registered user** is automatically promoted to the `admin` role.

Subsequent registrations start as `user` role. Admins can promote users to `premium` or `admin` at `/admin/users`.

## Step 6: Verify the deployment

Run through this checklist:

1. **Login**: Register and log in successfully.
2. **Admin access**: Navigate to `/admin/users` — should show the user list.
3. **Ingestion**: Go to `/admin/ingestion`, upload a small text PDF, verify the job appears and processes.
4. **Search**: Use the search form to find content from the ingested PDF.
5. **Role access**: Create a `user` account and verify it cannot access `/admin/` routes.

## Docker Compose reference

### Service details

**app** (Next.js):

- Built from the project Dockerfile using the `dev` stage.
- Runs `npm run dev` with Turbopack for hot-reloading in development.
- Bind-mounts the project directory for live code updates.
- Uses a named volume for `node_modules` to avoid host/container conflicts.
- Uses a named volume `app_storage` for file storage.
- Mounts canonical `DND_DATA_ROOT` read-only. Publication requests write only to the shared publication spool and Redis queue.

**worker** (Ingestion worker):

- Same Docker image as the app.
- Runs `npm run worker` which polls the Redis queue for ingestion jobs.
- Shares the `app_storage` volume with the app for file access.
- Is the sole read-write owner of canonical `DND_DATA_ROOT`; do not run any app container with that mount writable.
- Requires the same environment variables as the app.
- The image includes PDF processing packages (`poppler-utils`, `qpdf`, `ghostscript`, `ocrmypdf`, `tesseract-ocr`, `tesseract-ocr-eng`, `tesseract-ocr-rus`) needed by the ingestion pipeline.

**postgres**:

- Uses the `pgvector/pgvector:pg16` image.
- Initializes with `docker/postgres/init/001-pgvector.sql` on first volume creation.
- Data persists in the `postgres_data` named volume.
- Health check confirms the database is ready before dependent services start.
- Must expose deterministic ICU collation `und-x-icu`; compendium name normalization never depends on host `LC_CTYPE`.

**redis**:

- Uses `redis:7-alpine` with AOF persistence enabled.
- Data persists in the `redis_data` named volume.
- Health check confirms Redis is responding.

### Useful commands

```bash
# Start all services
docker compose up -d --build

# View logs
docker compose logs -f app
docker compose logs -f worker

# Restart a single service
docker compose restart app

# Run migrations
docker compose exec app npm run db:migrate

# Shell into the app container
docker compose exec app sh

# Check service status
docker compose ps

# Stop all services (preserves data)
docker compose down

# Stop and delete all data volumes
docker compose down -v

# Rebuild after dependency changes
docker compose build --no-cache app worker
```

### Troubleshooting

**Port conflicts**: If ports 3000, 5432, or 6379 are already in use, set `APP_PORT`, `POSTGRES_PORT`, or `REDIS_PORT` in `.env`.

**Stale dependencies**: Rebuild with `docker compose build --no-cache app worker`. If the `node_modules` volume is stale, run `docker compose down -v` (this deletes data volumes too).

**Missing pgvector extension**: If the `vector` extension is missing after changing init scripts, recreate the Postgres volume: `docker compose down -v` then `docker compose up -d`.

**Worker PDF/OCR failures**: The Docker image installs the PDF processing packages required by the worker. If you run `npm run worker` directly on Debian/Ubuntu instead of Docker, install the same system dependencies on the host.

Minimum required for text extraction:

```bash
sudo apt-get update && sudo apt-get install -y poppler-utils
```

Full normalization and OCR pipeline:

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

`poppler-utils` provides `pdfinfo` and `pdftotext`; without those, ingestion jobs fail before PDF text extraction. Missing `qpdf`, `ghostscript`, `ocrmypdf`, or Tesseract keeps the worker running but degrades normalization/OCR quality. The worker logs a startup preflight warning listing missing tools before it processes jobs.

**Redis connection errors**: Ensure the worker and app can reach `redis:6379` on the internal Docker network. Check `docker compose logs redis`.

**Publication storage**: The example Compose bind mount demonstrates app read-only and worker read-write ownership. For NFS deployment, configure the mount on the host or in deployment infrastructure rather than adding server credentials to the application. Mount the same export at `DND_DATA_ROOT` in both containers with `ro` for the app and `rw` for workers. Keep `PUBLICATION_SPOOL_ROOT` on durable storage shared by every app and worker instance, outside the canonical mount. Checksummed generation reservations use fsynced unique temporary files plus exclusive hard-link installation and directory fsync, so the shared filesystem must provide those semantics consistently to all submitters. Reservation filenames are permanent consumed tombstones and must not be manually removed; valid complete reservations participate in the ordering floor. All canonical repository directories must be on one filesystem because revision and activation-delta installation rely on same-filesystem atomic rename. Canonical directories must not be symlinks and must not be renameable by untrusted processes. PostgreSQL advisory locks are a contention optimization only; publication ordering survives PostgreSQL rebuild because reservations, semantically valid commands, and no-follow canonical activation deltas are rescanned before allocation. Consumers must support `readerContractVersion: 1` and fold activation deltas; direct reads of bootstrap `manifests/repository.json` are not active-state reads. See `content-repository/README.md` for the resolver contract, cache consistency, outbox recovery, and durability assumptions.

## Reverse proxy setup

For production, run behind a reverse proxy (nginx, Caddy, Traefik) that handles TLS termination.

Example nginx snippet:

```nginx
server {
    listen 443 ssl http2;
    server_name dnd.firegory.site;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `APP_URL` and `NEXT_PUBLIC_APP_URL` to the public HTTPS URL.

## Upgrading

```bash
git pull origin main
docker compose up -d --build
docker compose exec app npm run db:migrate
```

Always run migrations after upgrading — new migrations may have been added.

## Production considerations

- **TLS**: Use a reverse proxy with valid certificates. Never expose the app directly on port 80.
- **Redis authentication**: Configure a Redis password in production. The development Compose file does not set one.
- **Database password**: Change from the development default.
- **Backups**: Set up regular PostgreSQL and storage backups (see [backups.md](backups.md)).
- **Monitoring**: Monitor the worker logs, ingestion job failure rates, and disk usage on the storage volume.
- **Disk space**: PDF originals and processed artifacts accumulate. Monitor `/app/storage` usage and plan capacity accordingly.
