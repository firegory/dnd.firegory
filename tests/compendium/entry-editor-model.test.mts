import assert from "node:assert/strict";
import test from "node:test";

import { blocksToBody, parseEditorEntryInput } from "../../src/server/compendium/entry-editor-model.ts";

const id = (suffix: string) => `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const valid = {
  canonicalKey: "shield", entryType: "spell", edition: "5e", language: "en",
  sourceId: id("1"), fileId: id("2"), slug: "shield", aliases: ["Barrier"],
  title: "Shield", summary: null,
  blocks: [{ type: "heading", text: "Effect" }, { type: "paragraph", text: "A barrier appears." }, { type: "list", items: ["Until next turn"] }],
  projection: { type: "spell", level: 1, school: "abjuration", castingTime: "Reaction", range: "Self", duration: "1 round", components: "V, S", classes: ["class:17", "class:3"], concentration: false, ritual: false },
  citations: [{ chunkId: id("3"), generationId: id("4"), kind: "block", fieldPath: null, blockOrder: 0, quote: "Shield", quoteSpanStart: 0, quoteSpanEnd: 6 }],
  reason: "Create the original entry.",
};

test("structured editor parses a type-aware draft and deterministically produces plain text", () => {
  const parsed = parseEditorEntryInput(valid);
  assert.equal(parsed.entryType, "spell");
  assert.deepEqual(parsed.projection.classes, ["class:17", "class:3"]);
  assert.equal(blocksToBody(parsed.blocks), "Effect\n\nA barrier appears.\n\n- Until next turn");
});

test("structured editor validates and normalizes stable spell class IDs", () => {
  const parsed = parseEditorEntryInput({ ...valid, projection: { ...valid.projection, classes: [" class:17 ", "class:3", "class:17"] } });
  assert.deepEqual(parsed.projection.classes, ["class:17", "class:3"]);
  for (const classes of [undefined, "class:17", [""], ["wizard"], ["class:17", 3], ["class:UPPER"]]) {
    const projection = { ...valid.projection, classes };
    assert.throws(() => parseEditorEntryInput({ ...valid, projection }), /classes|unsupported fields/i);
  }
});

test("structured editor rejects HTML, unknown root fields, and mismatched projections", () => {
  assert.throws(() => parseEditorEntryInput({ ...valid, blocks: [{ type: "paragraph", text: "<script>alert(1)</script>" }] }), /cannot contain HTML/);
  assert.throws(() => parseEditorEntryInput({ ...valid, unsafeHtml: "<b>x</b>" }), /unsupported fields/);
  assert.throws(() => parseEditorEntryInput({ ...valid, title: "<img src=x>" }), /cannot contain HTML/);
  assert.throws(() => parseEditorEntryInput({ ...valid, projection: { ...valid.projection, castingTime: "<b>Reaction</b>" } }), /cannot contain HTML/);
  assert.throws(() => parseEditorEntryInput({ ...valid, projection: { type: "species", size: "medium", speed: 30 } }), /projection|Projection/);
});

test("structured editor requires source citations and exact finite fields", () => {
  assert.throws(() => parseEditorEntryInput({ ...valid, citations: [] }), /At least one/);
  assert.throws(() => parseEditorEntryInput({ ...valid, edition: "2024" }), /unsupported/);
  assert.throws(() => parseEditorEntryInput({ ...valid, projection: { ...valid.projection, arbitrary: true } }), /unsupported fields/);
});
