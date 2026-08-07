import type { NextDndNormalizedDetail } from "./parser.ts";
import type { ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";

export type SnapshotGuideReviewCandidate = Readonly<{
  schemaVersion: 1;
  kind: "staticGuideReviewCandidate";
  slug: string;
  locale: "ru" | "en";
  source: Readonly<{ url: string; sha256: string; parserVersion: string; attribution: string }>;
  blocks: readonly Readonly<{
    id: string;
    kind: "paragraph" | "callout";
    text: string;
    citation: Readonly<{ quote: string; quoteSpanStart: number; quoteSpanEnd: number }>;
  }>[];
  review: Readonly<{ workflow: "#76"; status: "pending" }>;
}>;

export type SnapshotGuideReviewBatch = Readonly<{
  occurrences: readonly ImportOccurrenceInput[];
  candidates: readonly ImportCandidateInput[];
}>;

export function extractSnapshotGuideForReview(input: Readonly<{
  slug: string;
  locale: "ru" | "en";
  sourceUrl: string;
  sha256: string;
  parserVersion: string;
  attribution: string;
  normalized: NextDndNormalizedDetail;
  blocks: readonly Readonly<{ id: string; kind: "paragraph" | "callout"; quote: string }>[];
}>): SnapshotGuideReviewCandidate {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) throw new Error("Guide extraction requires a stable slug.");
  if (!isSafeSourceUrl(input.sourceUrl) || !/^[a-f0-9]{64}$/.test(input.sha256) || !input.parserVersion.trim() || !input.attribution.trim()) {
    throw new Error("Guide extraction requires complete snapshot provenance.");
  }
  if (input.blocks.length === 0 || new Set(input.blocks.map(({ id }) => id)).size !== input.blocks.length) {
    throw new Error("Guide extraction requires unique cited blocks.");
  }
  const text = input.normalized.contentText;
  const blocks = input.blocks.map((block) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(block.id) || !block.quote.trim()) throw new Error("Guide blocks require stable IDs and text.");
    const start = text.indexOf(block.quote);
    if (start < 0 || text.indexOf(block.quote, start + 1) >= 0) throw new Error(`Guide block ${block.id} must cite one unambiguous normalized-text span.`);
    const quoteSpanStart = Array.from(text.slice(0, start)).length;
    return {
      id: block.id,
      kind: block.kind,
      text: block.quote,
      citation: { quote: block.quote, quoteSpanStart, quoteSpanEnd: quoteSpanStart + Array.from(block.quote).length },
    };
  });
  return {
    schemaVersion: 1,
    kind: "staticGuideReviewCandidate",
    slug: input.slug,
    locale: input.locale,
    source: { url: input.sourceUrl, sha256: input.sha256, parserVersion: input.parserVersion, attribution: input.attribution },
    blocks,
    review: { workflow: "#76", status: "pending" },
  };
}

/** Produces #76 review inputs that contain cited plain text, never collected HTML. */
export function snapshotGuideReviewBatch(candidate: SnapshotGuideReviewCandidate): SnapshotGuideReviewBatch {
  if (candidate.review.workflow !== "#76" || candidate.review.status !== "pending" || candidate.blocks.length === 0) {
    throw new Error("Only pending cited guide candidates can enter review.");
  }
  return {
    occurrences: [{ occurrenceIndex: 0, locator: candidate.source.url, fingerprintSha256: candidate.source.sha256 }],
    candidates: [{
      occurrenceIndex: 0,
      candidateKey: `guide-${candidate.locale}-${candidate.slug}`,
      entryType: null,
      content: candidate,
    }],
  };
}

function isSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
