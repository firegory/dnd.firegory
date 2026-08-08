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
  const hierarchySlots = slot.planSlot.snapshotCategory === "class" && ["feature", "class"].includes(slot.planSlot.contentType);
  const selected = hierarchySlots ? slot.manifest.categories[0].details.flatMap((detail) => {
    const occurrence = base.occurrences.find((candidate) => candidate.locator === detail.sourceUrl)!;
    const hierarchy = base.candidates.find((candidate) => candidate.occurrenceIndex === occurrence.occurrenceIndex)!;
    return [
      ...featureCandidates(detail).map((content) => ({ occurrence, candidate: { occurrenceIndex: 0, candidateKey: content.externalId, entryType: "feature" as const, content } })),
      { occurrence, candidate: hierarchy },
    ];
  }) : base.candidates.flatMap((candidate) => candidate.entryType === slot.planSlot.contentType
    ? [{ candidate, occurrence: base.occurrences[candidate.occurrenceIndex] }] : []);
  if (slot.planSlot.contentType === "feature" && !selected.some(({ candidate }) => candidate.entryType === "feature")) throw new Error("The required feature slot discovered no class feature candidates.");
  return reindex(selected);
}

function reindex(selected: readonly Readonly<{ occurrence: ImportOccurrenceInput; candidate: ImportCandidateInput }>[]) {
  return {
    occurrences: selected.map(({ occurrence }, occurrenceIndex) => ({ ...occurrence, occurrenceIndex })),
    candidates: selected.map(({ candidate }, occurrenceIndex) => ({ ...candidate, occurrenceIndex })),
  };
}
