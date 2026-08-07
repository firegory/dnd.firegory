import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { classifyCandidatePublication } from "../../src/server/compendium/candidate-publication.ts";
import type { NextDndSnapshotManifest, SnapshotResource } from "../../src/server/compendium/next-dnd/collector.ts";
import {
  extractSnapshotGuideForReview,
  feedSnapshotGuideToImportRun,
  snapshotGuideReviewBatch,
} from "../../src/server/compendium/next-dnd/guide-extraction.ts";

describe("collected article guide extraction", () => {
  it("derives a cited non-null guide candidate from verified collector files", async () => {
    const collected = await collectorRun("Roll once. Then act.", "<script>bad()</script><p>Roll once. Then act.</p>");
    const candidate = await extractSnapshotGuideForReview({
      runDirectory: collected.runDirectory, category: "spells", externalId: "10195", slug: "starter", locale: "en",
      attribution: "Source attribution", blocks: [{ id: "roll", kind: "paragraph", quote: "Roll once." }],
    });
    const batch = snapshotGuideReviewBatch(candidate);

    assert.deepEqual(candidate.blocks[0].citation, { quote: "Roll once.", quoteSpanStart: 0, quoteSpanEnd: 10 });
    assert.equal(candidate.review.status, "pending");
    assert.equal(candidate.source.sha256, collected.blobSha256);
    assert.equal(candidate.source.blobPath, `blobs/${collected.blobSha256}.html`);
    assert.equal(candidate.source.collectorRunSha256, collected.manifestSha256);
    assert.equal(batch.candidates[0].entryType, "guide");
    assert.equal(batch.candidates[0].candidateKey, "en-starter");
    assert.equal(batch.occurrences[0].fingerprintSha256, collected.blobSha256);
    assert.equal(batch.occurrences[0].rawBlobPath, `blobs/${collected.blobSha256}.html`);
    assert.equal(batch.occurrences[0].sourceFetchedAt, "2026-08-06T12:00:00.000Z");
    assert.equal(JSON.stringify(batch).includes("contentHtml"), false);
    assert.equal(JSON.stringify(batch).includes("<script>"), false);
    assert.deepEqual(classifyCandidatePublication(candidate, {
      candidateKey: "en-starter", entryType: "guide", sourceId: "source", fileId: "file", generationId: null,
      edition: "5.5e", language: "en", accessTier: "open", shared: false, ownerUserId: null, chunk: null,
    }), {
      payloadOrigin: "collector_snapshot", publicationCapability: "requires_extraction",
      publicationBlockReason: "Collector snapshot candidates require chunk-backed canonical extraction before publication.",
    });
  });

  it("passes the real #75 occurrence and diff phases for #76 review", async () => {
    const calls: Array<{ phase: string; value: unknown }> = [];
    const collected = await collectorRun("Rules text.");
    const candidate = await extractSnapshotGuideForReview({
      runDirectory: collected.runDirectory, category: "spells", externalId: "10195", slug: "basics", locale: "en",
      attribution: "Source", blocks: [{ id: "rules", kind: "callout", quote: "Rules text." }],
    });
    await feedSnapshotGuideToImportRun({
      async recordOccurrences(runId, leaseToken, occurrences, actor) { calls.push({ phase: "occurrences", value: { runId, leaseToken, occurrences, actor } }); },
      async computeCandidateDiff(runId, leaseToken, candidates, actor) { calls.push({ phase: "candidates", value: { runId, leaseToken, candidates, actor } }); return []; },
    }, "run", "lease", candidate, "collector");
    assert.deepEqual(calls.map(({ phase }) => phase), ["occurrences", "candidates"]);
    assert.equal((calls[1].value as { candidates: Array<{ entryType: string }> }).candidates[0].entryType, "guide");
  });

  it("rejects ambiguous citations and unverified collector provenance", async () => {
    const duplicate = await collectorRun("Один текст. Один текст.");
    await assert.rejects(extractSnapshotGuideForReview({
      runDirectory: duplicate.runDirectory, category: "spells", externalId: "10195", slug: "basics", locale: "ru",
      attribution: "Source", blocks: [{ id: "one", kind: "callout", quote: "Один текст." }],
    }), /unambiguous/);

    const unsafe = await collectorRun("Один текст.", undefined, { sourceUrl: "https://user:secret@next.dnd.su/spells/10195" });
    await assert.rejects(extractSnapshotGuideForReview({
      runDirectory: unsafe.runDirectory, category: "spells", externalId: "10195", slug: "basics", locale: "ru",
      attribution: "Source", blocks: [{ id: "one", kind: "callout", quote: "Один текст." }],
    }), /provenance/);

    const partial = await collectorRun("Один текст.", undefined, { status: "partial" });
    await assert.rejects(extractSnapshotGuideForReview({
      runDirectory: partial.runDirectory, category: "spells", externalId: "10195", slug: "basics", locale: "ru",
      attribution: "Source", blocks: [{ id: "one", kind: "callout", quote: "Один текст." }],
    }), /complete collector run/);

    const tampered = await collectorRun("Один текст.");
    await writeFile(tampered.blobFile, "tampered");
    await assert.rejects(extractSnapshotGuideForReview({
      runDirectory: tampered.runDirectory, category: "spells", externalId: "10195", slug: "basics", locale: "ru",
      attribution: "Source", blocks: [{ id: "one", kind: "callout", quote: "Один текст." }],
    }), /blob failed byte\/hash verification/);
  });

  it("measures citation offsets in Unicode code points", async () => {
    const collected = await collectorRun("🎲 Бросьте d20.");
    const candidate = await extractSnapshotGuideForReview({
      runDirectory: collected.runDirectory, category: "spells", externalId: "10195", slug: "basics", locale: "ru",
      attribution: "Source", blocks: [{ id: "test", kind: "paragraph", quote: "Бросьте d20." }],
    });
    assert.equal(candidate.blocks[0].citation.quoteSpanStart, 2);
    assert.equal(candidate.blocks[0].citation.quoteSpanEnd, 14);
  });
});

function resource(kind: SnapshotResource["kind"], sourceUrl: string, category: SnapshotResource["category"], externalId: string | null, sha256: string, byteLength: number): SnapshotResource {
  return { kind, category, externalId, sourceUrl, finalUrl: sourceUrl, redirectChain: [], fetchedAt: "2026-08-06T12:00:00.000Z", sha256, byteLength, parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${sha256}.html` };
}

async function collectorRun(contentText: string, rawHtml = `<article>${contentText}</article>`, overrides: Readonly<{ sourceUrl?: string; status?: NextDndSnapshotManifest["status"] }> = {}) {
  const blob = Buffer.from(rawHtml);
  const blobSha256 = sha256(blob);
  const sourceUrl = overrides.sourceUrl ?? "https://next.dnd.su/spells/10195";
  const robots = resource("robots", "https://next.dnd.su/robots.txt", null, null, "b".repeat(64), 100);
  const index = resource("index", "https://next.dnd.su/spells/", "spells", null, "c".repeat(64), 100);
  const detail = resource("detail", sourceUrl, "spells", "10195", blobSha256, blob.byteLength);
  const manifest: NextDndSnapshotManifest = {
    schemaVersion: 2, parserVersion: "next-dnd-2024-v3", status: overrides.status ?? "complete", collectedAt: "2026-08-06T12:00:00.000Z",
    robots: { userAgent: "dnd.firegory.site-snapshot", snapshot: robots, rules: [], evaluations: [] }, parserFailures: [], diagnostics: [],
    categories: [{ requestedCategory: "spells", discoveredCategory: "spells", entryCount: 1, index, details: [{ ...detail, kind: "detail", category: "spells", externalId: "10195", normalized: { title: "Guide", contentHtml: rawHtml, contentText }, indexMetadata: {} }] }],
  };
  const manifestSha256 = sha256(Buffer.from(JSON.stringify(manifest)));
  const output = await mkdtemp(join(tmpdir(), "guide-collector-"));
  const runDirectory = join(output, "runs", manifestSha256);
  const blobFile = join(output, "blobs", `${blobSha256}.html`);
  await mkdir(runDirectory, { recursive: true });
  await mkdir(join(output, "blobs"), { recursive: true });
  await writeFile(join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(blobFile, blob);
  return { runDirectory, blobFile, blobSha256, manifestSha256 };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
