import assert from "node:assert/strict";
import test from "node:test";

import { feedNextDndSnapshotToImportRun, nextDndImportBatch, spellCandidate } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import type { NextDndSnapshotManifest, SnapshotResource } from "../../src/server/compendium/next-dnd/collector.ts";
import { nextDndCardFingerprint } from "../../src/server/compendium/next-dnd/parser.ts";

const resource = (kind: SnapshotResource["kind"], sourceUrl: string, category: SnapshotResource["category"], externalId: string | null, hash: string): SnapshotResource => ({
  kind,
  category,
  externalId,
  sourceUrl,
  finalUrl: sourceUrl,
  redirectChain: [],
  fetchedAt: "2026-08-06T12:00:00.000Z",
  sha256: hash,
  byteLength: 100,
  parserVersion: "next-dnd-2024-v3",
  blobPath: `blobs/${hash}.html`,
});
const robotsSnapshot = resource("robots", "https://next.dnd.su/robots.txt", null, null, "b".repeat(64));
const indexSnapshot = resource("index", "https://next.dnd.su/spells/", "spells", null, "c".repeat(64));
const detailSnapshot = resource("detail", "https://next.dnd.su/spells/10195-hunters-mark", "spells", "10195", "a".repeat(64));

const manifest: NextDndSnapshotManifest = {
  schemaVersion: 2,
  parserVersion: "next-dnd-2024-v3",
  status: "complete",
  collectedAt: "2026-08-06T12:00:00.000Z",
  robots: { userAgent: "dnd.firegory.site-snapshot", snapshot: robotsSnapshot, rules: [], evaluations: [{ sourceUrl: indexSnapshot.sourceUrl, allowed: true }] },
  parserFailures: [],
  diagnostics: [],
  categories: [{
    requestedCategory: "spells",
    discoveredCategory: "spells",
    entryCount: 1,
    index: indexSnapshot,
    details: [{
      ...detailSnapshot,
      kind: "detail",
      category: "spells",
      externalId: "10195",
      normalized: { title: "Метка охотника", contentHtml: "<article>Rules</article>", contentText: "Rules" },
      indexMetadata: { level: 1 },
      indexSource: {
        url: indexSnapshot.sourceUrl, fingerprintSha256: indexSnapshot.sha256, rawBlobPath: indexSnapshot.blobPath,
        fetchedAt: indexSnapshot.fetchedAt, cardFingerprintSha256: nextDndCardFingerprint({ level: 1 }),
      },
    }],
  }],
};

test("maps complete snapshots to stable #75 occurrences and candidates", () => {
  const batch = nextDndImportBatch(manifest);
  assert.deepEqual(batch.occurrences, [{
    occurrenceIndex: 0, locator: detailSnapshot.sourceUrl, fingerprintSha256: "a".repeat(64),
    rawBlobPath: `blobs/${"a".repeat(64)}.html`, sourceFetchedAt: "2026-08-06T12:00:00.000Z",
    indexLocator: indexSnapshot.sourceUrl, indexFingerprintSha256: indexSnapshot.sha256,
    rawIndexBlobPath: indexSnapshot.blobPath, indexSourceFetchedAt: indexSnapshot.fetchedAt,
    indexCardFingerprintSha256: nextDndCardFingerprint({ level: 1 }),
    metadataEvidenceText: "window.LIST card metadata\nlevel=1\nschool=null\nritual=false\nconcentration=false\nclasses=[]",
  }]);
  assert.equal(batch.candidates[0].candidateKey, "spells-10195");
  assert.equal(batch.candidates[0].entryType, "spell");
  assert.equal(batch.candidates[0].content.parserVersion, "next-dnd-2024-v3");
});

test("rejects metadata that does not match the exact collected index card fingerprint", () => {
  const detail = manifest.categories[0].details[0];
  assert.throws(() => spellCandidate({ ...detail, indexMetadata: { level: 2 } }), /exact collected window\.LIST card fingerprint/);
});

test("feeds only occurrence and candidate phases for a complete snapshot", async () => {
  const calls: string[] = [];
  await feedNextDndSnapshotToImportRun(target(calls) as never, "run", "lease", manifest, "collector");
  assert.deepEqual(calls, ["occurrences:1:collector", "candidates:1:collector"]);
});

test("fails incomplete #75 runs before diffing so missing candidates cannot be created", async () => {
  const calls: string[] = [];
  const incomplete: NextDndSnapshotManifest = {
    ...manifest,
    status: "partial",
    parserFailures: [{
      category: "spells",
      externalId: "10195",
      sourceUrl: detailSnapshot.sourceUrl,
      stage: "detail",
      phase: "fetch",
      message: "timeout",
      snapshot: null,
    }],
    categories: [{ ...manifest.categories[0], details: [] }],
  };
  assert.throws(() => nextDndImportBatch(incomplete), /incomplete.*cannot produce import candidates/i);
  await feedNextDndSnapshotToImportRun(target(calls) as never, "run", "lease", incomplete, "collector");
  assert.deepEqual(calls, ["diagnostic:next_dnd_incomplete_snapshot:error", "failed:The next.dnd.su snapshot is incomplete."]);
  assert.ok(!calls.some((call) => call.startsWith("occurrences") || call.startsWith("candidates") || call.startsWith("completed")));
});

test("records stale cache fallback diagnostics before feeding a complete run", async () => {
  const calls: string[] = [];
  const stale: NextDndSnapshotManifest = {
    ...manifest,
    diagnostics: [{ code: "stale-cache-fallback", sourceUrl: detailSnapshot.sourceUrl, message: "HTTP 503 Busy", attempts: 2 }],
  };
  await feedNextDndSnapshotToImportRun(target(calls) as never, "run", "lease", stale, "collector");
  assert.deepEqual(calls, ["diagnostic:stale_cache_fallback:warning", "occurrences:1:collector", "candidates:1:collector"]);
});

function target(calls: string[]) {
  return {
    async addDiagnostic(_runId: string, _lease: string, input: { code: string; level: string }) {
      calls.push(`diagnostic:${input.code}:${input.level}`);
    },
    async failRun(_runId: string, _lease: string, _actor: string, message: string) {
      calls.push(`failed:${message}`);
    },
    async recordOccurrences(_runId: string, _lease: string, occurrences: readonly unknown[], actor: string) {
      calls.push(`occurrences:${occurrences.length}:${actor}`);
    },
    async computeCandidateDiff(_runId: string, _lease: string, candidates: readonly unknown[], actor: string) {
      calls.push(`candidates:${candidates.length}:${actor}`);
      return [];
    },
  };
}
