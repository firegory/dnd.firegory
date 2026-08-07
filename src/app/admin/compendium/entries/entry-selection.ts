export type EntrySelection = Readonly<{ versionId: string; entryId: string }>;

export function detailMatchesSelection(selection: EntrySelection | null, detail: EntrySelection | null): boolean {
  return selection !== null && detail !== null
    && selection.versionId === detail.versionId
    && selection.entryId === detail.entryId;
}

export function shouldApplyDetailResponse(input: Readonly<{
  requestSequence: number;
  currentSequence: number;
  requested: EntrySelection;
  selected: EntrySelection | null;
  response: EntrySelection;
}>): boolean {
  return input.requestSequence === input.currentSequence
    && detailMatchesSelection(input.requested, input.selected)
    && detailMatchesSelection(input.requested, input.response);
}

export function mutationStillTargetsSelection(input: Readonly<{
  mutationEpoch: number;
  currentEpoch: number;
  captured: EntrySelection | null;
  selected: EntrySelection | null;
}>): boolean {
  if (input.mutationEpoch !== input.currentEpoch) return false;
  if (input.captured === null) return input.selected === null;
  return detailMatchesSelection(input.captured, input.selected);
}
