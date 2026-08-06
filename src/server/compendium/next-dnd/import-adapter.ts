import type { CompendiumImportRunService, ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";
import { NEXT_DND_CATEGORIES } from "./parser.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "./collector.ts";

type ImportRunAdapterTarget = Pick<CompendiumImportRunService, "recordOccurrences" | "computeCandidateDiff">;

export function nextDndImportBatch(manifest: NextDndSnapshotManifest): Readonly<{
  occurrences: readonly ImportOccurrenceInput[];
  candidates: readonly ImportCandidateInput[];
}> {
  const details = manifest.categories.flatMap((category) => category.details);
  return {
    occurrences: details.map((detail, occurrenceIndex) => ({
      occurrenceIndex,
      locator: detail.sourceUrl,
      fingerprintSha256: detail.sha256,
    })),
    candidates: details.map((detail, occurrenceIndex) => candidate(detail, occurrenceIndex)),
  };
}

export async function feedNextDndSnapshotToImportRun(
  target: ImportRunAdapterTarget,
  runId: string,
  leaseToken: string,
  manifest: NextDndSnapshotManifest,
  actor: string,
): Promise<void> {
  const batch = nextDndImportBatch(manifest);
  await target.recordOccurrences(runId, leaseToken, batch.occurrences, actor);
  await target.computeCandidateDiff(runId, leaseToken, batch.candidates, actor);
}

function candidate(detail: SnapshotDetail, occurrenceIndex: number): ImportCandidateInput {
  return {
    occurrenceIndex,
    candidateKey: `${detail.category}-${detail.externalId}`,
    entryType: NEXT_DND_CATEGORIES[detail.category].entryType,
    content: {
      externalId: detail.externalId,
      sourceUrl: detail.sourceUrl,
      sha256: detail.sha256,
      parserVersion: detail.parserVersion,
      title: detail.normalized.title,
      contentHtml: detail.normalized.contentHtml,
      contentText: detail.normalized.contentText,
      indexMetadata: detail.indexMetadata,
    },
  };
}
