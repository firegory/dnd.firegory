import type { ImportCandidateInput, ImportOccurrenceInput } from "../compendium/import-runs.ts";
import { nextDndImportBatch } from "../compendium/next-dnd/import-adapter.ts";
import { featureCandidates } from "../compendium/next-dnd/hierarchy-import.ts";
import type { PreparedSeedSlot } from "./model.ts";

export const REVIEW_API_BATCH_SIZE = 200;

export function reviewActionBatches(candidates: readonly Readonly<{ id: string; activeRevisionToken: string | null }>[]) {
  const batches: Array<Readonly<{ candidateIds: readonly string[]; activeRevisionTokens: Readonly<Record<string, string | null>> }>> = [];
  for (let offset = 0; offset < candidates.length; offset += REVIEW_API_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + REVIEW_API_BATCH_SIZE);
    batches.push({ candidateIds: batch.map(({ id }) => id), activeRevisionTokens: Object.fromEntries(batch.map(({ id, activeRevisionToken }) => [id, activeRevisionToken])) });
  }
  return batches;
}

export function seedImportBatch(slot: PreparedSeedSlot): Readonly<{ occurrences: readonly ImportOccurrenceInput[]; candidates: readonly ImportCandidateInput[] }> {
  const base = nextDndImportBatch(slot.manifest);
  if (slot.planSlot.contentType !== "feature") {
    const selected = base.candidates.flatMap((candidate) => candidate.entryType === slot.planSlot.contentType ? [{ candidate, occurrence: base.occurrences[candidate.occurrenceIndex] }] : []);
    return reindex(selected);
  }
  const selected = slot.manifest.categories[0].details.flatMap((detail) => featureCandidates(detail).map((content) => ({
    occurrence: base.occurrences.find((candidate) => candidate.locator === detail.sourceUrl)!,
    candidate: { occurrenceIndex: 0, candidateKey: content.externalId, entryType: "feature" as const, content },
  })));
  if (selected.length === 0) throw new Error("The required feature slot discovered no class feature candidates.");
  return reindex(selected);
}

function reindex(selected: readonly Readonly<{ occurrence: ImportOccurrenceInput; candidate: ImportCandidateInput }>[]) {
  return {
    occurrences: selected.map(({ occurrence }, occurrenceIndex) => ({ ...occurrence, occurrenceIndex })),
    candidates: selected.map(({ candidate }, occurrenceIndex) => ({ ...candidate, occurrenceIndex })),
  };
}
