# dnd.firegory

Private, self-hosted D&D 5e/5.5e search and citation-first RAG site for `dnd.firegory.site`.

## Package manager

This repository uses **npm** because it is available with the project Node.js runtime and does not require an additional package-manager bootstrap step.

## Local development

```bash
npm install
npm run dev
```

The app starts at <http://localhost:3000> and currently renders a minimal placeholder page.

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

Compose uses the `pgvector/pgvector:pg16` image and initializes the database with `CREATE EXTENSION IF NOT EXISTS vector;` from `docker/postgres/init/001-pgvector.sql` on first database volume creation.

To reset local infrastructure data:

```bash
docker compose down -v
```

This removes the Compose-managed Postgres, Redis, dependency, and storage volumes. Do not run it if you need to keep local data.

### Compose troubleshooting

- If port `3000`, `5432`, or `6379` is already in use, set `APP_PORT`, `POSTGRES_PORT`, or `REDIS_PORT` in `.env` or export them before running Compose.
- If the app container has stale dependencies, rebuild with `docker compose build --no-cache app worker`.
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

## Dependency notes

`package.json` includes an npm `overrides.postcss` entry so `npm audit --omit=dev` resolves to zero known production vulnerabilities while Next.js still depends on a vulnerable PostCSS range.

## Configuration

Copy `.env.example` to `.env.local` for Next.js/npm local-only values, or to `.env` for Docker Compose overrides:

```bash
cp .env.example .env.local
cp .env.example .env
```

Required variable names are documented in `.env.example`. Do not commit real secrets or local `.env` files.

## Current scope

This bootstrap includes the minimal Next.js + TypeScript application skeleton, Docker Compose development infrastructure, and basic developer scripts. Database schema, auth, ingestion, and RAG implementation are planned for later issues.
