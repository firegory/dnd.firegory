import assert from "node:assert/strict";
import test from "node:test";

import { feedNextDndSnapshotToImportRun, nextDndImportBatch } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import type { NextDndSnapshotManifest } from "../../src/server/compendium/next-dnd/collector.ts";

const manifest: NextDndSnapshotManifest = {
  schemaVersion: 1,
  parserVersion: "next-dnd-2024-v1",
  collectedAt: "2026-08-06T12:00:00.000Z",
  parserFailures: [],
  categories: [{
    requestedCategory: "spells",
    discoveredCategory: "spells",
    entryCount: 1,
    index: null,
    details: [{
      kind: "detail",
      category: "spells",
      externalId: "10195",
      sourceUrl: "https://next.dnd.su/spells/10195-hunters-mark",
      fetchedAt: "2026-08-06T12:00:00.000Z",
      sha256: "a".repeat(64),
      parserVersion: "next-dnd-2024-v1",
      blobPath: `blobs/${"a".repeat(64)}.html`,
      normalized: { title: "Метка охотника", contentHtml: "<article>Rules</article>", contentText: "Rules" },
      indexMetadata: { level: 1 },
    }],
  }],
};

test("maps snapshots to stable #75 occurrences and candidates", () => {
  const batch = nextDndImportBatch(manifest);
  assert.deepEqual(batch.occurrences, [{ occurrenceIndex: 0, locator: "https://next.dnd.su/spells/10195-hunters-mark", fingerprintSha256: "a".repeat(64) }]);
  assert.equal(batch.candidates[0].candidateKey, "spells-10195");
  assert.equal(batch.candidates[0].entryType, "spell");
  assert.equal(batch.candidates[0].content.parserVersion, "next-dnd-2024-v1");
});

test("feeds only the defined #75 occurrence and candidate phases", async () => {
  const calls: string[] = [];
  const target = {
    async recordOccurrences(_runId: string, _lease: string, occurrences: readonly unknown[], actor: string) {
      calls.push(`occurrences:${occurrences.length}:${actor}`);
    },
    async computeCandidateDiff(_runId: string, _lease: string, candidates: readonly unknown[], actor: string) {
      calls.push(`candidates:${candidates.length}:${actor}`);
      return [];
    },
  };
  await feedNextDndSnapshotToImportRun(target as never, "run", "lease", manifest, "collector");
  assert.deepEqual(calls, ["occurrences:1:collector", "candidates:1:collector"]);
});
