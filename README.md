# dnd.firegory

Private, self-hosted D&D 5e/5.5e search and citation-first RAG site for `dnd.firegory.site`.

## Package manager

This repository uses **npm** because it is available with the project Node.js runtime and does not require an additional package-manager bootstrap step.

## Local development

```bash
npm install
npm run dev
```

The app starts at <http://localhost:3000>. Run database migrations before registering or signing in:

```bash
export DATABASE_URL="postgres://dnd:dnd_dev_password@localhost:5432/dnd_firegory"
npm run db:migrate
npm run dev
```

The first registered account is promoted to `admin`; later accounts start as `user`. Admins can manage roles at `/admin/users`.

## Docker Compose development

The repository includes a local Compose stack with:

- `app`: Next.js development server.
- `worker`: placeholder process for the future ingestion/RAG worker.
- `postgres`: PostgreSQL 16 with `pgvector` available.
- `redis`: Redis queue/cache service.

Start the stack:

```bash
# Defaults are provided by docker-compose.yml for dev.
docker compose up --build
```

To override Compose values, either export variables in your shell or create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
# Fill local values as needed; .env is git-ignored.
docker compose up --build
```

Useful service URLs and ports:

- App: <http://localhost:3000> (`APP_PORT` overrides host port).
- Postgres: `localhost:5432` (`POSTGRES_PORT` overrides host port).
- Redis: `localhost:6379` (`REDIS_PORT` overrides host port).

Compose uses the `pgvector/pgvector:pg16` image and initializes the database with `CREATE EXTENSION IF NOT EXISTS vector;` from `docker/postgres/init/001-pgvector.sql` on first database volume creation. By default, app and worker derive `DATABASE_URL` inside the container from `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`; set `DATABASE_URL` explicitly if they should use a different database. Redis is intentionally unauthenticated and host-exposed for local development only; do not use this Compose file as-is on a shared network or public host.

To reset local infrastructure data:

```bash
docker compose down -v
```

This removes the Compose-managed Postgres, Redis, dependency, and storage volumes. Do not run it if you need to keep local data.

### Compose troubleshooting

- If port `3000`, `5432`, or `6379` is already in use, set `APP_PORT`, `POSTGRES_PORT`, or `REDIS_PORT` in `.env` or export them before running Compose.
- If the app container has stale dependencies, rebuild with `docker compose build --no-cache app worker`; if the named `node_modules` volume is stale, reset local volumes with `docker compose down -v`.
- If the `vector` extension is missing after changing init scripts, recreate the Postgres volume with `docker compose down -v` and start again.

## Developer commands

```bash
npm run lint
npm run typecheck
npm run build
npm start
```

Validate Compose syntax without starting services:

```bash
docker compose config
```

## Database migrations

The MVP schema uses plain SQL migrations in `migrations/` and a small Node runner backed by `pg`.
The first migration enables `pgcrypto` and `pgvector`, then creates auth, source/file, ingestion, document/page/chunk, and diagnostic tables.

Run migrations against a local Postgres instance:

```bash
# If using Compose defaults from this repository:
export DATABASE_URL="postgres://dnd:dnd_dev_password@localhost:5432/dnd_firegory"
npm run db:migrate
```

Inside the Compose app/worker network, the equivalent connection string is:

```text
postgres://dnd:dnd_dev_password@postgres:5432/dnd_firegory
```

The runner records applied files in `schema_migrations`, so rerunning `npm run db:migrate` is repeatable and skips migrations that were already applied.

## Dependency notes

`package.json` includes an npm `overrides.postcss` entry so `npm audit --omit=dev` resolves to zero known production vulnerabilities while Next.js still depends on a vulnerable PostCSS range.

## Configuration

Copy `.env.example` to `.env.local` for Next.js/npm local-only values, or to `.env` for Docker Compose overrides:

```bash
cp .env.example .env.local
cp .env.example .env
```

Required variable names are documented in `.env.example`. Do not commit real secrets or local `.env` files.

## CLI ingestion

A CLI command is available for batch and debug PDF ingestion. It uses the same ingestion lifecycle as the admin UI.

### Prerequisites

The CLI requires running Postgres and Redis services and these environment variables:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string
- `STORAGE_ROOT` — root directory for file storage

### Usage

```bash
npm run ingest -- \
  --pdf path/to/book.pdf \
  --title "Player's Handbook" \
  --category core_rules \
  --edition 5e \
  --language en \
  --access open
```

### Options

| Option | Required | Description |
| --- | --- | --- |
| `--pdf` | yes | Path to a local PDF file |
| `--title` | yes | Source title for the ingestion record |
| `--category` | yes | `core_rules`, `official_supplement`, or `homebrew` |
| `--edition` | yes | `5e` or `5.5e` |
| `--language` | yes | `en` or `ru` |
| `--access` | yes | `open`, `premium`, or `personal` |
| `--owner-user-id` | no | Owner user ID for personal content |
| `--help` | no | Show usage information |

On success the CLI prints the created source, file, and job identifiers along with the initial job status. If the file is missing, empty, or metadata is invalid, the command exits with a non-zero code and a readable error message.

## Current scope

This repository currently includes the minimal Next.js + TypeScript application skeleton, Docker Compose development infrastructure, the initial database schema/migration runner, password registration/login, database-backed sessions, and admin role management. Content ingestion, search, and RAG implementation are planned for later issues.
