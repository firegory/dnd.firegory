import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractSnapshotGuideForReview,
  snapshotGuideReviewBatch,
} from "../../src/server/compendium/next-dnd/guide-extraction.ts";

const hash = "a".repeat(64);

describe("collected article guide extraction", () => {
  it("emits cited plain-text #76 candidates without raw HTML", () => {
    const candidate = extractSnapshotGuideForReview({
      slug: "starter",
      locale: "en",
      sourceUrl: "https://next.dnd.su/article/1",
      sha256: hash,
      parserVersion: "next-dnd-2024-v3",
      attribution: "Source attribution",
      normalized: { title: "Guide", contentHtml: "<script>bad()</script><p>Roll once. Then act.</p>", contentText: "Roll once. Then act." },
      blocks: [{ id: "roll", kind: "paragraph", quote: "Roll once." }],
    });
    const batch = snapshotGuideReviewBatch(candidate);

    assert.deepEqual(candidate.blocks[0].citation, { quote: "Roll once.", quoteSpanStart: 0, quoteSpanEnd: 10 });
    assert.equal(candidate.review.workflow, "#76");
    assert.equal(batch.candidates[0].entryType, null);
    assert.equal(batch.candidates[0].candidateKey, "guide-en-starter");
    assert.equal(batch.occurrences[0].fingerprintSha256, hash);
    assert.equal(JSON.stringify(batch).includes("contentHtml"), false);
    assert.equal(JSON.stringify(batch).includes("<script>"), false);
  });

  it("rejects ambiguous citations and unsafe provenance", () => {
    const base = {
      slug: "basics",
      locale: "ru" as const,
      sourceUrl: "https://next.dnd.su/article/2",
      sha256: hash,
      parserVersion: "v1",
      attribution: "Source",
      normalized: { title: "Guide", contentHtml: "", contentText: "Один текст. Один текст." },
      blocks: [{ id: "one", kind: "callout" as const, quote: "Один текст." }],
    };
    assert.throws(() => extractSnapshotGuideForReview(base), /unambiguous/);
    assert.throws(() => extractSnapshotGuideForReview({ ...base, sourceUrl: "https://user:secret@example.test/article" }), /provenance/);
  });

  it("measures citation offsets in Unicode code points", () => {
    const candidate = extractSnapshotGuideForReview({
      slug: "basics",
      locale: "ru",
      sourceUrl: "https://next.dnd.su/article/3",
      sha256: hash,
      parserVersion: "v1",
      attribution: "Source",
      normalized: { title: "Guide", contentHtml: "", contentText: "🎲 Бросьте d20." },
      blocks: [{ id: "test", kind: "paragraph", quote: "Бросьте d20." }],
    });
    assert.equal(candidate.blocks[0].citation.quoteSpanStart, 2);
    assert.equal(candidate.blocks[0].citation.quoteSpanEnd, 14);
  });
});
