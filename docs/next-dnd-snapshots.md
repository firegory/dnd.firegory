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

`--allow-network` is mandatory for any invocation that can contact upstream. The collector library also requires an explicit `allowNetwork` boolean, so callers cannot bypass consent by skipping the CLI. Repeat `--category` to select multiple categories; omitting it selects all supported 2024 compendium categories. Requests are sequential and have a positive 1000 ms minimum delay by default. `--delay-ms` changes the delay, and `--retries` controls exponential retry attempts after the initial request.

Every online run fetches a fresh `/robots.txt` before any index or detail request, even when normal content is cached. A robots refresh failure fails closed: cached robots are never used to authorize an online request and no other URL is requested. Cached robots are accepted only with explicit `--offline` cache-only collection. Normal index/detail reruns prefer the retained URL cache. Use `--refresh --allow-network` to re-fetch those cached URLs. A missing offline cache entry is recorded as a failure and never causes a network request. After exhausted index/detail refresh retries, a valid retained cache entry is preferred and a `stale-cache-fallback` diagnostic is retained. Cached and pre-existing content-addressed blobs are byte-length and SHA-256 verified before use.

Network requests use manual redirects with a bounded redirect count. Every initial and redirected URL must be credential-free HTTPS on the exact `next.dnd.su` host, and every DNS result must be a public address. The validated address is pinned into a one-request `node:https` connection lookup; the original hostname remains the TLS SNI name and Host header. This prevents a second DNS answer from rebinding the connection to a private address. Each request has an abort timeout and streams into a bounded byte buffer. Only transient network errors and HTTP 408, 425, 429, 500, 502, 503, and 504 responses are retried; `Retry-After` is honored. Fresh robots bytes are retained as raw evidence and evaluated for every index and detail URL.

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
    collection-diagnostics.json
```

Raw robots, index, and detail response bytes are immutable and content-addressed. The manifest records each snapshot's category, external ID where applicable, requested and final URLs, redirect chain, `fetchedAt`, byte length, SHA-256, parser version, and blob path. It also has an explicit `complete`, `partial`, or `failed` status. A detail page that downloads but fails normalization remains referenced by its parser failure record. Identical cache-backed runs resolve to the same manifest directory. Collection never removes blobs, cache records, previous runs, candidates, drafts, or published content.

`category-discovery.json` records requested local categories, the category label found in each `window.LIST`, index entry counts, and successfully normalized detail counts. `parser-failures.json` distinguishes fetch failures from parse failures and includes raw snapshot metadata whenever bytes were fetched.

## Parsing boundary

Index parsing accepts literal JSON assigned to `window.LIST`; it does not execute JavaScript. The discovered `window.LIST.category` must exactly equal the requested category; no aliases or implicit mappings are accepted. Detail parsing uses Cheerio on the server and requires the exact category and external ID in `.card[data-id]`. Navigation, comments, authentication forms, partner content, and page chrome are excluded. Normalized HTML is rebuilt through explicit semantic tag, attribute, and URL-protocol allowlists; scripts, event attributes, styles, SVG, iframes, forms, active resources, and `javascript:` URLs are removed. The unmodified source bytes remain in `blobs/`.

No live network access is used in tests. The fixtures model the current 411-card spell list shape and representative detail page chrome.

## Import-run adapter

`src/server/compendium/next-dnd/import-adapter.ts` is the only bridge from snapshots to the resumable import workflow from issue #75. `feedNextDndSnapshotToImportRun` accepts an already-created and claimed run. Complete manifests call only `recordOccurrences` and `computeCandidateDiff`; collection diagnostics are copied to the run first. It does not create drafts, complete review, or publish revisions.

Occurrence fingerprints use raw detail HTML hashes. Candidate keys use `<category>-<external-id>`, and candidate payloads retain the URL, raw hash, parser version, normalized content, and index metadata. Fetch time remains in the snapshot manifest rather than candidate content, so byte-identical refreshes stay unchanged during candidate diffing. Partial or failed manifests cannot produce a batch: the adapter records an error diagnostic, fails the leased #75 run, and never records occurrences or computes a diff. This prevents an incomplete scrape from creating `missing` candidates or reaching completion. No deletion or publication action is performed.

Snapshot candidates are intentionally outside the canonical publication boundary. They have auditable HTML snapshots but no immutable chunk, page, or field-level quote evidence, so review classifies them as `collector_snapshot` with `requires_extraction` capability. Approve, merge, unpublish, retry, and mixed bulk publication requests fail before review state or queue mutation; rejection and collection diagnostics remain available. A future snapshot-to-canonical extraction stage must produce the same chunk-backed, field-cited payload contract as #77 before these candidates can become publishable.

Beginner-guide article selection is a separate plain-text review boundary documented in `docs/beginner-guides.md`. It resolves source data from a complete collector manifest, records the immutable blob occurrence through #75, and creates non-null `guide` candidates for pending #76 review. Candidate provenance includes the collector-run hash, source/final URLs, blob path/hash, byte length, fetch time, parser version, and source identity. It omits `contentHtml` and cannot publish collected markup.
