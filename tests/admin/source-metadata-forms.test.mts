import assert from "node:assert/strict";
import test from "node:test";

import {
  createSourceMetadataFormState,
  sourceMetadataPatchFromForm,
} from "../../src/app/admin/sources/[sourceId]/source-metadata-form.ts";
import {
  createUploadSourceFormState,
  resetUploadSourceFormState,
} from "../../src/app/admin/ingestion/upload-source-form.ts";
import type { SourceMetadataRecord } from "../../src/server/content/metadata.ts";

const ownerUserId = "11111111-1111-4111-8111-111111111111";

test("existing-source editor initializes and resets from that source only", () => {
  const source = sourceRecord();
  const initial = createSourceMetadataFormState(source);

  assert.equal(initial.edition, "5e");
  assert.equal(initial.language, "en");
  assert.equal(initial.publicationCode, "PHB-2014");
  assert.deepEqual(createSourceMetadataFormState(source), initial);
  assert.equal(sourceMetadataPatchFromForm(initial).ownerUserId, ownerUserId);
});

test("upload success reset clears every source-specific field but keeps remembered defaults", () => {
  const populated = {
    ...createUploadSourceFormState({ edition: "5e", language: "en" }),
    title: "Previous source",
    category: "homebrew",
    accessTier: "personal",
    canonicalSourceId: "previous-source",
    publicationCode: "OLD",
    publicationTitle: "Old publication",
    publisher: "Old publisher",
    releaseYear: "2014",
    revision: "reprint",
    originUrl: "https://example.com/old",
    originId: "old",
    attribution: "Old attribution",
    sourcePriority: "900",
    canonicalBookId: "old-book",
    license: "Old license",
  };

  assert.deepEqual(
    resetUploadSourceFormState(populated),
    createUploadSourceFormState({ edition: "5e", language: "en" }),
  );
});

function sourceRecord(): SourceMetadataRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    canonicalSourceId: "players-handbook-2014-en",
    title: "Player's Handbook",
    category: "core_rules",
    edition: "5e",
    language: "en",
    accessTier: "personal",
    shared: false,
    ownerUserId,
    publication: {
      code: "PHB-2014",
      title: "Player's Handbook",
      publisher: "Wizards of the Coast",
      releaseYear: 2014,
      revision: "first printing",
      origin: { url: "https://example.com/phb", id: "phb" },
      attribution: "Player's Handbook, Wizards of the Coast",
      sourcePriority: 100,
      canonicalBookId: "players-handbook",
    },
    license: "All rights reserved",
    metadata: {},
    createdByUserId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    deletedAt: null,
  };
}
