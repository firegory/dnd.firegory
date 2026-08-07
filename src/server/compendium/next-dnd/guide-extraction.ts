import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { CompendiumImportRunService, ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";
import type { NextDndCategory } from "./parser.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "./collector.ts";

type GuideReviewTarget = Pick<CompendiumImportRunService, "recordOccurrences" | "computeCandidateDiff">;

export type SnapshotGuideReviewCandidate = Readonly<{
  schemaVersion: 1;
  kind: "staticGuideReviewCandidate";
  slug: string;
  locale: "ru" | "en";
  source: Readonly<{
    collectorRunSha256: string;
    category: NextDndCategory;
    externalId: string;
    url: string;
    finalUrl: string;
    sha256: string;
    byteLength: number;
    blobPath: string;
    fetchedAt: string;
    parserVersion: string;
    attribution: string;
  }>;
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

export async function extractSnapshotGuideForReview(input: Readonly<{
  runDirectory: string;
  category: NextDndCategory;
  externalId: string;
  slug: string;
  locale: "ru" | "en";
  attribution: string;
  blocks: readonly Readonly<{ id: string; kind: "paragraph" | "callout"; quote: string }>[];
}>): Promise<SnapshotGuideReviewCandidate> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) throw new Error("Guide extraction requires a stable slug.");
  if (!input.attribution.trim()) throw new Error("Guide extraction requires source attribution.");
  if (input.blocks.length === 0 || new Set(input.blocks.map(({ id }) => id)).size !== input.blocks.length) {
    throw new Error("Guide extraction requires unique cited blocks.");
  }
  const { detail, manifestSha256: collectorRunSha256 } = await loadCollectorDetail(input.runDirectory, input.category, input.externalId);
  const text = detail.normalized.contentText;
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
    source: {
      collectorRunSha256,
      category: detail.category,
      externalId: detail.externalId,
      url: detail.sourceUrl,
      finalUrl: detail.finalUrl,
      sha256: detail.sha256,
      byteLength: detail.byteLength,
      blobPath: detail.blobPath,
      fetchedAt: detail.fetchedAt,
      parserVersion: detail.parserVersion,
      attribution: input.attribution.trim(),
    },
    blocks,
    review: { workflow: "#76", status: "pending" },
  };
}

/** Produces #75/#76 inputs containing cited plain text, never collected HTML. */
export function snapshotGuideReviewBatch(candidate: SnapshotGuideReviewCandidate): SnapshotGuideReviewBatch {
  if (candidate.review.workflow !== "#76" || candidate.review.status !== "pending" || candidate.blocks.length === 0) {
    throw new Error("Only pending cited guide candidates can enter review.");
  }
  return {
    occurrences: [{
      occurrenceIndex: 0,
      locator: candidate.source.url,
      fingerprintSha256: candidate.source.sha256,
      rawBlobPath: candidate.source.blobPath,
      sourceFetchedAt: candidate.source.fetchedAt,
    }],
    candidates: [{
      occurrenceIndex: 0,
      candidateKey: `${candidate.locale}-${candidate.slug}`,
      entryType: "guide",
      content: candidate,
    }],
  };
}

export async function feedSnapshotGuideToImportRun(
  target: GuideReviewTarget,
  runId: string,
  leaseToken: string,
  candidate: SnapshotGuideReviewCandidate,
  actor: string,
): Promise<void> {
  const batch = snapshotGuideReviewBatch(candidate);
  await target.recordOccurrences(runId, leaseToken, batch.occurrences, actor);
  await target.computeCandidateDiff(runId, leaseToken, batch.candidates, actor);
}

function collectorDetail(manifest: NextDndSnapshotManifest, category: NextDndCategory, externalId: string): SnapshotDetail {
  if (manifest.status !== "complete" || !manifest.robots || manifest.parserFailures.length > 0) {
    throw new Error("Guide extraction requires a complete collector run.");
  }
  const collectedCategory = manifest.categories.find((item) => item.requestedCategory === category);
  const detail = collectedCategory?.details.find((item) => item.externalId === externalId);
  if (!collectedCategory?.index || collectedCategory.discoveredCategory !== category || !detail) {
    throw new Error("Guide extraction source is absent from the collector run.");
  }
  if (detail.parserVersion !== manifest.parserVersion
    || detail.blobPath !== `blobs/${detail.sha256}.html`
    || !/^[a-f0-9]{64}$/.test(detail.sha256)
    || !Number.isSafeInteger(detail.byteLength) || detail.byteLength < 1
    || !isCollectorUrl(detail.sourceUrl) || !isCollectorUrl(detail.finalUrl)) {
    throw new Error("Guide extraction collector provenance is inconsistent.");
  }
  return detail;
}

async function loadCollectorDetail(runDirectory: string, category: NextDndCategory, externalId: string): Promise<Readonly<{
  detail: SnapshotDetail;
  manifestSha256: string;
}>> {
  const directory = resolve(runDirectory);
  const directoryHash = basename(directory);
  if (!/^[a-f0-9]{64}$/.test(directoryHash) || basename(dirname(directory)) !== "runs") {
    throw new Error("Guide extraction requires a content-addressed collector run directory.");
  }
  let manifest: NextDndSnapshotManifest;
  try {
    manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as NextDndSnapshotManifest;
  } catch (error) {
    throw new Error(`Guide extraction could not read the collector manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifestSha256(manifest) !== directoryHash) throw new Error("Guide extraction collector manifest hash does not match its run directory.");
  const detail = collectorDetail(manifest, category, externalId);
  const outputDirectory = dirname(dirname(directory));
  const blobFile = resolve(outputDirectory, detail.blobPath);
  if (blobFile !== resolve(outputDirectory, "blobs", `${detail.sha256}.html`)) {
    throw new Error("Guide extraction blob path escapes collector content addressing.");
  }
  const bytes = await readFile(blobFile);
  if (bytes.byteLength !== detail.byteLength || createHash("sha256").update(bytes).digest("hex") !== detail.sha256) {
    throw new Error("Guide extraction collector blob failed byte/hash verification.");
  }
  return { detail, manifestSha256: directoryHash };
}

function manifestSha256(manifest: NextDndSnapshotManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function isCollectorUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "next.dnd.su" && !url.username && !url.password;
  } catch {
    return false;
  }
}
