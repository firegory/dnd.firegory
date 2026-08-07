import assert from "node:assert/strict";
import test from "node:test";

import { detailMatchesSelection, mutationStillTargetsSelection, shouldApplyDetailResponse } from "../../src/app/admin/compendium/entries/entry-selection.ts";

const oldEntry = { versionId: "version-old", entryId: "entry-old" };
const newEntry = { versionId: "version-new", entryId: "entry-new" };

test("a stale detail response cannot replace the newly selected entry", () => {
  assert.equal(shouldApplyDetailResponse({
    requestSequence: 1,
    currentSequence: 2,
    requested: oldEntry,
    selected: newEntry,
    response: oldEntry,
  }), false);
  assert.equal(shouldApplyDetailResponse({
    requestSequence: 2,
    currentSequence: 2,
    requested: newEntry,
    selected: newEntry,
    response: { ...newEntry, entryId: "wrong-entry" },
  }), false);
  assert.equal(shouldApplyDetailResponse({ requestSequence: 2, currentSequence: 2, requested: newEntry, selected: newEntry, response: newEntry }), true);
});

test("old entry detail is never actionable after a new entry is selected", () => {
  assert.equal(detailMatchesSelection(newEntry, oldEntry), false, "publish and save guards reject old detail");
  assert.equal(detailMatchesSelection(newEntry, newEntry), true);
  assert.equal(detailMatchesSelection(null, oldEntry), false);
});

test("selecting B while A save is in flight prevents A completion from reloading", () => {
  assert.equal(mutationStillTargetsSelection({
    mutationEpoch: 4,
    currentEpoch: 5,
    captured: oldEntry,
    selected: newEntry,
  }), false);
  assert.equal(mutationStillTargetsSelection({
    mutationEpoch: 4,
    currentEpoch: 4,
    captured: oldEntry,
    selected: newEntry,
  }), false, "identity mismatch also blocks reload if events share a render epoch");
});

test("switching to New Entry while A publish is in flight prevents A completion from reloading", () => {
  assert.equal(mutationStillTargetsSelection({
    mutationEpoch: 8,
    currentEpoch: 9,
    captured: oldEntry,
    selected: null,
  }), false);
  assert.equal(mutationStillTargetsSelection({ mutationEpoch: 9, currentEpoch: 9, captured: null, selected: null }), true);
});
