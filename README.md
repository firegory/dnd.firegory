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

## Developer commands

```bash
npm run lint
npm run typecheck
npm run build
npm start
```

## Dependency notes

`package.json` includes an npm `overrides.postcss` entry so `npm audit --omit=dev` resolves to zero known production vulnerabilities while Next.js still depends on a vulnerable PostCSS range.

## Configuration

Copy `.env.example` to `.env.local` for local-only values when configuration is added:

```bash
cp .env.example .env.local
```

Do not commit real secrets or local `.env` files.

## Current scope

This bootstrap only includes the minimal Next.js + TypeScript application skeleton and basic developer scripts. Database, auth, worker, Docker Compose, ingestion, and RAG implementation are planned for later issues.
