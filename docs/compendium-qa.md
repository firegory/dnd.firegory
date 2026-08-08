# Compendium QA

Issue #95 is covered by deterministic local checks and fail-closed live groups. Live groups do not skip when PostgreSQL, pgvector, a production build, or Chromium is unavailable.

## Prerequisites

- Node.js 22 and `npm ci`.
- PostgreSQL 16 with the `vector` extension already installed.
- Chromium installed with `npm run qa:browser:install` for browser QA.
- No Redis, LLM, external website, or network access is used while tests run.

Set `QA_DATABASE_URL` to a disposable PostgreSQL database. Tests create uniquely named schemas, use the production migration runner/files, and drop their schemas afterward. The browser group uses `QA_BROWSER_SCHEMA` (default `qa_browser`) and recreates that schema. QA schema names must begin with `qa_`; never point it at a schema containing data to retain.

```bash
export QA_DATABASE_URL='postgres://qa:qa@127.0.0.1:5432/dnd_qa'
```

## Groups

| Group | Command | Coverage |
| --- | --- | --- |
| Deterministic regression | `npm run qa:unit` | Existing Node tests, including auth, SQL construction, ingestion, UI models, routes, Compose, and publication helpers. No database or browser required. |
| Database | `npm run qa:db` | Fresh and upgrade production migrations on PostgreSQL 16 + pgvector; anonymous-equivalent/open, user, premium, personal owner, admin, no-content, source, language, and edition access; import failure, retry, immutable replay, completion, and idempotency. |
| NFS publication | `npm run qa:publication` | Real temporary filesystem publication, lease/fence doubles only, crash points before activation installation, atomic reader visibility, retry, stale writers, and idempotency. The filesystem must provide the documented NFS rename/fsync contract. |
| Browser | `npm run build && npm run qa:browser` | Production Next server and real PostgreSQL fixtures: anonymous boundary, landing, API filters, category navigation, deep links, mobile overflow, editor, review filters, citations, and print media. |
| Representative volume | `npm run qa:performance` | 10,000 generated published records plus baseline fixtures, production read service, and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. |
| Production regressions | `npm run qa:build` | Typecheck, lint, and standalone production build. |

Run the complete CI sequence locally when all prerequisites exist:

```bash
npm run qa:unit
npm run qa:db
npm run qa:publication
npm run qa:performance
npm run qa:build
npm run qa:browser
```

## Performance Contract

The default representative volume is `10,000` generated rows. The list query must return 50 rows from the production service and remain below:

- Execution time: `1,500 ms`
- Planning time: `250 ms`

The plan must retain deterministic title ordering. Evidence is written to `qa-artifacts/compendium-list-plan.json` and uploaded by CI. Controlled environments may set `QA_VOLUME_ROWS`, `QA_MAX_QUERY_MS`, or `QA_MAX_PLANNING_MS`; invalid or out-of-range values fail before the test runs.

These are CI regression limits, not production capacity claims. The plan artifact includes measured values, thresholds, buffer data in the plan tree, and the tested row count.

## Isolation And Failure

- Database and performance tests use random schemas and always register cleanup.
- Browser setup recreates only the explicitly validated `QA_BROWSER_SCHEMA` and teardown drops it.
- All fixtures are local and deterministic. Browser requests do not call external origins, embeddings, Redis, or an LLM.
- Missing `QA_DATABASE_URL`, PostgreSQL 16, pgvector, browser binaries, migrations, build output, or required fixture state is an error, never a skip.
- Playwright uses one worker, no retries, event/locator waits, and no arbitrary sleeps.
