# Deployment Guide

This guide covers the production stack in `compose.production.yml`. The existing
`docker-compose.yml` remains the live-reload development stack and is still
started with `docker compose up --build`.

## Prerequisites

- A server with Docker and Docker Compose installed.
- At least 2 GB RAM (4 GB recommended for OCR-heavy workloads).
- Sufficient disk space for PostgreSQL data, Redis, and file storage.
- Network access to the z.ai API (for embeddings and LLM features).
- PostgreSQL 16 built with ICU and the deterministic root collation `und-x-icu` (provided by the Compose image).
- An NFSv4 export already mounted on the Docker host. Compose does not provision,
  mount, or authenticate to NFS.

## Step 1: Clone the repository

```bash
git clone https://github.com/firegory/dnd.firegory.git
cd dnd.firegory
```

## Step 2: Configure environment

```bash
cp .env.example .env
```

Edit `.env` with non-secret deployment values:

```bash
# Required host path; this same absolute path is used inside containers
DND_DATA_ROOT=/mnt/dnd-firegory

# Numeric identities must match the host NFS export ownership/ACLs
APP_UID=10001
APP_GID=10001
WORKER_UID=10001
WORKER_GID=10001
GATEWAY_UID=10001
GATEWAY_GID=10001
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# App URLs
APP_URL=https://dnd.firegory.site
NEXT_PUBLIC_APP_URL=https://dnd.firegory.site

# PostgreSQL (Compose internal)
POSTGRES_DB=dnd_firegory
POSTGRES_USER=dnd

# Optional host ports and secret directory
APP_PORT=3000
AGENT_GATEWAY_PORT=8787
PRODUCTION_SECRETS_ROOT=./secrets
```

Create the secret files below under `PRODUCTION_SECRETS_ROOT`; every file must
end with a newline. Values shown are descriptions, not usable credentials.

| File | Contents |
| --- | --- |
| `postgres-password` | PostgreSQL role password |
| `database-url` | `postgresql://dnd:<password>@postgres:5432/dnd_firegory` |
| `redis-password` | Redis password |
| `redis-url` | `redis://:<password>@redis:6379` |
| `auth-secret` | Random application secret, at least 32 bytes |
| `zai-api-key` | Embedding provider key, or an empty line when unused |
| `llm-api-key` | LLM provider key, or an empty line when unused |
| `agent-token-policies.json` | Gateway token policy JSON documented in `agent-gateway.md` |
| `agent-cursor-key` | Random gateway cursor HMAC key, at least 32 bytes |

The secret directory is git-ignored. Compose mounts these files through Docker
secrets and does not place their values in generated container configuration.

### Security notes

- Generate `auth-secret` and `agent-cursor-key` with cryptographically random values.
- Use distinct strong PostgreSQL and Redis passwords.
- PostgreSQL and Redis have no production host port mapping; access them through the Compose network.
- Never commit `.env` to version control.

### Host NFSv4 assumptions

Mount the export on the host before starting Compose, for example at
`/mnt/dnd-firegory`, and set `DND_DATA_ROOT` to that absolute path. Mount options,
server address, Kerberos material, and other NFS credentials belong in host
configuration such as `/etc/fstab` or an infrastructure manager, never in this
repository or generated Compose configuration.

The export must provide NFSv4 close-to-open consistency, same-filesystem atomic
rename, hard links, file and directory fsync behavior, and stable numeric UID/GID
mapping. Root squashing is expected. Grant app and gateway identities read and
traverse access only; grant the worker identity read/write/create/rename access.
The defaults use one identity (`10001:10001`), with Docker's `ro` bind flags
enforcing app/gateway immutability. Distinct IDs are supported when host ACLs
provide equivalent access. Changing IDs or `DND_DATA_ROOT` only requires editing
`.env` and recreating containers; images do not need rebuilding.

## Step 3: Start services

```bash
docker compose -f compose.production.yml up -d --build
```

This starts five services:

| Service | Description | Internal port |
| --- | --- | --- |
| `app` | Next.js web application | 3000 |
| `worker` | Background ingestion worker | — |
| `gateway` | Read-only agent HTTP/MCP gateway | 8787 |
| `postgres` | PostgreSQL 16 + pgvector | 5432 |
| `redis` | Job queue and cache | 6379 |

The first start initializes the PostgreSQL database with the pgvector extension.

## Step 4: Run migrations

```bash
docker compose -f compose.production.yml exec app npm run db:migrate
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

- Built from the multi-stage `app-production` target and runs as a configurable non-root UID/GID.
- Runs the prebuilt Next.js production server.
- Uses the local named volume `upload_spool` for uploads and publication commands.
- Mounts canonical `DND_DATA_ROOT` read-only. Publication requests write only to the shared publication spool and Redis queue.

**worker** (Ingestion worker):

- Built from the multi-stage `worker-production` target with PDF/OCR runtime tools.
- Runs `npm run worker` which polls the Redis queue for ingestion jobs.
- Shares the local `upload_spool` volume with the app for file access.
- Is the sole read-write owner of canonical `DND_DATA_ROOT`; do not run any app container with that mount writable.
- Requires the same environment variables as the app.
- The image includes PDF processing packages (`poppler-utils`, `qpdf`, `ghostscript`, `ocrmypdf`, `tesseract-ocr`, `tesseract-ocr-eng`, `tesseract-ocr-rus`) needed by the ingestion pipeline.

**gateway**:

- Reuses the minimal `agent-gateway` target from the gateway implementation.
- Runs as a configurable non-root UID/GID and mounts canonical content read-only.
- Receives token policies and cursor key material only through secret files.

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
docker compose -f compose.production.yml up -d --build

# View logs
docker compose -f compose.production.yml logs -f app
docker compose -f compose.production.yml logs -f worker

# Restart a single service
docker compose -f compose.production.yml restart app

# Run migrations
docker compose -f compose.production.yml exec app npm run db:migrate

# Shell into the app container
docker compose -f compose.production.yml exec app sh

# Check service status
docker compose -f compose.production.yml ps

# Stop all services (preserves data)
docker compose -f compose.production.yml down

# Stop and delete all data volumes
docker compose -f compose.production.yml down -v

# Rebuild after dependency changes
docker compose -f compose.production.yml build --no-cache app worker gateway
```

Run `npm run production:config` to validate Compose. It parses and checks the
production contract statically, then invokes `docker compose config` when Docker
is installed. `npm run production:smoke` builds the stack,
waits for all five healthchecks, proves app/gateway read-only and worker
read-write canonical access, then replaces app and verifies canonical, spool,
PostgreSQL, and Redis persistence.

### Troubleshooting

**Port conflicts**: If the published app or gateway port is already in use, set
`APP_PORT` or `AGENT_GATEWAY_PORT` in `.env`. PostgreSQL and Redis are not
published on host ports in the production stack.

**Stale images**: Rebuild with `docker compose -f compose.production.yml build --no-cache app worker gateway`.

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

**Publication storage**: Production Compose bind-mounts the host's existing NFSv4 path and never provisions NFS. App and gateway use `ro`; worker alone uses `rw`. Keep the local `upload_spool` named volume outside canonical storage. Checksummed generation reservations use fsynced unique temporary files plus exclusive hard-link installation and directory fsync, so the shared filesystem must provide those semantics consistently to all submitters. Reservation filenames are permanent consumed tombstones and must not be manually removed; valid complete reservations participate in the ordering floor. All canonical repository directories must be on one filesystem because revision and activation-delta installation rely on same-filesystem atomic rename. Canonical directories must not be symlinks and must not be renameable by untrusted processes. PostgreSQL advisory locks are a contention optimization only; publication ordering survives PostgreSQL rebuild because reservations, semantically valid commands, and no-follow canonical activation deltas are rescanned before allocation. Deploy v1+v2-capable readers before upgrading the bootstrap to `readerContractVersion: 2`; unpublication remains blocked until then. Direct reads of bootstrap `manifests/repository.json` are not active-state reads. See `content-repository/README.md` for the resolver contract, cache consistency, outbox recovery, and durability assumptions.

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
docker compose -f compose.production.yml up -d --build
docker compose -f compose.production.yml exec app npm run db:migrate
```

Always run migrations after upgrading — new migrations may have been added.

## Production considerations

- **TLS**: Use a reverse proxy with valid certificates. Never expose the app directly on port 80.
- **Redis authentication**: Configure a Redis password in production. The development Compose file does not set one.
- **Database password**: Change from the development default.
- **Backups**: Set up regular PostgreSQL and storage backups (see [backups.md](backups.md)).
- **Monitoring**: Monitor the worker logs, ingestion job failure rates, and disk usage on the storage volume.
- **Disk space**: PDF originals and processed artifacts accumulate. Monitor `/app/storage` usage and plan capacity accordingly.
