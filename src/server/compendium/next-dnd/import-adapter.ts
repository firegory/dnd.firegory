import type { CompendiumImportRunService, ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";
import { NEXT_DND_CATEGORIES } from "./parser.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "./collector.ts";

type ImportRunAdapterTarget = Pick<CompendiumImportRunService, "addDiagnostic" | "failRun" | "recordOccurrences" | "computeCandidateDiff">;

export function nextDndImportBatch(manifest: NextDndSnapshotManifest): Readonly<{
  occurrences: readonly ImportOccurrenceInput[];
  candidates: readonly ImportCandidateInput[];
}> {
  if (!isCompleteManifest(manifest)) throw new Error("An incomplete next.dnd.su manifest cannot produce import candidates.");
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
  if (!isCompleteManifest(manifest)) {
    await target.addDiagnostic(runId, leaseToken, {
      diagnosticKey: "next-dnd-incomplete-snapshot",
      level: "error",
      code: "next_dnd_incomplete_snapshot",
      message: "The next.dnd.su snapshot is incomplete; candidate diffing was not started.",
      details: {
        manifestStatus: manifest.status,
        parserFailureCount: manifest.parserFailures.length,
        incompleteCategories: manifest.categories.filter((category) => category.index === null || category.details.length !== category.entryCount).map((category) => category.requestedCategory),
      },
      actor,
    });
    await target.failRun(runId, leaseToken, actor, "The next.dnd.su snapshot is incomplete.");
    return;
  }
  for (const [index, diagnostic] of manifest.diagnostics.entries()) {
    await target.addDiagnostic(runId, leaseToken, {
      diagnosticKey: `next-dnd-collection-${index}`,
      level: "warning",
      code: diagnostic.code.replaceAll("-", "_"),
      message: diagnostic.message,
      details: { sourceUrl: diagnostic.sourceUrl, attempts: diagnostic.attempts },
      actor,
    });
  }
  const batch = nextDndImportBatch(manifest);
  await target.recordOccurrences(runId, leaseToken, batch.occurrences, actor);
  await target.computeCandidateDiff(runId, leaseToken, batch.candidates, actor);
}

function isCompleteManifest(manifest: NextDndSnapshotManifest): boolean {
  return manifest.status === "complete"
    && manifest.robots !== null
    && manifest.parserFailures.length === 0
    && manifest.categories.length > 0
    && manifest.categories.every((category) => category.index !== null && category.details.length === category.entryCount);
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
