# next.dnd.su 2024 snapshots

The snapshot collector preserves auditable HTML inputs for the 2024 compendium. It is an explicitly invoked administrative tool, not a scheduled crawler, browser automation, publication path, or dependency on an undocumented API. It only requests public HTML pages and parses the inline JSON object assigned to `window.LIST`.

## Run the collector

Node.js 22 or newer is required by the repository scripts.

```bash
npm run collect:next-dnd -- \
  --output /srv/dnd-firegory/next-dnd-snapshots \
  --category spells \
  --allow-network
```

`--allow-network` is mandatory for any invocation that can contact upstream. Repeat `--category` to select multiple categories; omitting it selects all supported 2024 compendium categories. Requests are sequential and have a 1000 ms minimum delay by default. `--delay-ms` changes the delay, and `--retries` controls exponential retry attempts after the initial request.

Normal reruns prefer the retained URL cache. Use `--refresh --allow-network` to re-fetch cached URLs. Use `--offline` for a cache-only run; a missing cache entry is recorded as a failure and never causes a network request. After exhausted refresh retries, a valid retained cache entry is preferred. Cached content is SHA-256 verified before use.

The CLI exits with status 2 when the run has fetch or parser failures. It still writes the run reports and retains every successfully fetched raw page.

## Snapshot layout

```text
<output>/
  blobs/<sha256>.html
  cache/<url-sha256>.json
  runs/<manifest-sha256>/
    manifest.json
    category-discovery.json
    parser-failures.json
```

Raw index and detail HTML is immutable and content-addressed. The manifest records each snapshot's category, external ID where applicable, source URL, `fetchedAt`, SHA-256, parser version, and blob path. A detail page that downloads but fails normalization remains referenced by its parser failure record. Identical cache-backed runs resolve to the same manifest directory. Collection never removes blobs, cache records, previous runs, candidates, drafts, or published content.

`category-discovery.json` records requested local categories, the category label found in each `window.LIST`, index entry counts, and successfully normalized detail counts. `parser-failures.json` distinguishes fetch failures from parse failures and includes raw snapshot metadata whenever bytes were fetched.

## Parsing boundary

Index parsing accepts literal JSON assigned to `window.LIST`; it does not execute JavaScript. Detail parsing uses Cheerio on the server and selects only the matching `.card[data-id]`. Navigation, comments, authentication forms, partner content, scripts, styles, card menus, and page chrome are excluded from normalized HTML and text. The unmodified source HTML remains in `blobs/`.

No live network access is used in tests. The fixtures model the current 411-card spell list shape and representative detail page chrome.

## Import-run adapter

`src/server/compendium/next-dnd/import-adapter.ts` is the only bridge from snapshots to the resumable import workflow from issue #75. `feedNextDndSnapshotToImportRun` accepts an already-created and claimed run, then calls only `recordOccurrences` and `computeCandidateDiff`. It does not create drafts, complete review, or publish revisions.

Occurrence fingerprints use raw detail HTML hashes. Candidate keys use `<category>-<external-id>`, and candidate payloads retain the URL, raw hash, parser version, normalized content, and index metadata. Fetch time remains in the snapshot manifest rather than candidate content, so byte-identical refreshes stay unchanged during candidate diffing. Entries absent from a later snapshot flow through #75's existing `missing` review status; no deletion or publication action is performed.
