# Compendium QA

Issue #95 is covered by deterministic local checks and fail-closed live groups. Live groups do not skip when PostgreSQL, pgvector, a production build, or Chromium is unavailable.

## Prerequisites

- Node.js 22 and `npm ci`.
- PostgreSQL 16 with the `vector` extension already installed.
- Chromium installed with `npm run qa:browser:install` for browser QA.
- No Redis, LLM, external website, or network access is used while tests run.

Set `QA_DATABASE_URL` to an administrative connection for a disposable PostgreSQL cluster. Tests create uniquely named databases, use the production migration runner/files, terminate their own remaining sessions, and drop those databases afterward. The browser group uses `QA_BROWSER_DATABASE` (default `qa_browser`) and recreates that database. QA database names must begin with `qa_`; never use a name containing data to retain.

```bash
export QA_DATABASE_URL='postgres://qa:qa@127.0.0.1:5432/dnd_qa'
```

## Groups

| Group | Command | Coverage |
| --- | --- | --- |
| Deterministic regression | `npm run qa:unit` | Existing Node tests, including auth, SQL construction, ingestion, UI models, routes, Compose, and publication helpers. No database or browser required. |
| Database | `npm run qa:db` | Fresh and prefix-upgrade production migrations in separate PostgreSQL 16 databases; suffix/idempotent reruns and data preservation; full source/corpus role matrix; transaction rollback, stale-lease retry, exact replay, and conflicting replay. |
| NFS publication | `npm run qa:publication` | Real temporary filesystem publication, crash hooks, and a separate worker process killed with `SIGKILL` after activation-file fsync but before rename; atomic reader visibility, retry, stale writers, and idempotency. |
| Browser | `npm run build && npm run qa:browser` | Production Next server, random hashed sessions, real PostgreSQL/NFS-index fixtures, actual filter controls, protected deep links, rendered PDF citation preview, mobile drawer navigation, print layout CSS, editor save/denial, and review transition/denial. |
| Representative volume | `npm run qa:performance` | At least 10,000 mixed indexed records across types, source priorities, tiers, owners, aliases, citations, and searchable text; production spell list/count/alias queries with separate `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` evidence. |
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

The default representative volume is `10,000` generated rows plus baseline fixtures. Each list, count, and alias query must return its asserted cardinality and remain below:

- Execution time: `1,500 ms`
- Planning time: `250 ms`

Plans reject a full-table `nfs_index_entries` sequential scan that visits at least 90% of the representative dataset to return under 1%; they do not require incidental planner nodes such as `Sort`. Evidence is written to `qa-artifacts/spell-{list,count,alias}-plan.json` and uploaded by CI. Controlled environments may set `QA_VOLUME_ROWS`, `QA_MAX_QUERY_MS`, or `QA_MAX_PLANNING_MS`; volume cannot be lowered below 10,000 and invalid values fail before the test runs.

These are CI regression limits, not production capacity claims. The plan artifact includes measured values, thresholds, buffer data in the plan tree, and the tested row count.

## Isolation And Failure

- Database and performance tests use separate random databases and always register cleanup.
- Browser setup recreates only the explicitly validated `QA_BROWSER_DATABASE`; auth states live under a mode-restricted `/tmp` directory and are never artifacts.
- All fixtures are local and deterministic. Browser requests do not call external origins, embeddings, Redis, or an LLM.
- Missing `QA_DATABASE_URL`, PostgreSQL 16, pgvector, browser binaries, migrations, build output, or required fixture state is an error, never a skip.
- Playwright uses one worker, no retries, event/locator waits, and no arbitrary sleeps.

The process-termination publication test exercises a real `SIGKILL` at the last pre-activation boundary on the runner filesystem. CI cannot terminate an NFS server or simulate server-side acknowledgement loss; production still depends on the documented NFS atomic rename, close-to-open, and durable `fsync` contract.
