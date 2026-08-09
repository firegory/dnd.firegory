import assert from "node:assert/strict";
import test from "node:test";

import { parseUploadSourceMetadata } from "../../src/server/ingestion/upload-metadata.ts";

test("ordinary upload metadata receives deterministic server defaults", () => {
  const formData = new FormData();
  formData.set("canonicalSourceId", "");

  assert.deepEqual(parseUploadSourceMetadata(formData, "Player's Handbook"), {
    canonicalSourceId: null,
    publication: {
      code: null,
      title: "Player's Handbook",
      publisher: null,
      releaseYear: null,
      revision: null,
      origin: null,
      attribution: null,
      sourcePriority: 0,
      canonicalBookId: null,
    },
    license: null,
  });
});

test("upload API compatibility retains explicit publication metadata and drops blank optionals", () => {
  const formData = new FormData();
  formData.set("canonicalSourceId", "players-handbook-2014-en");
  formData.set("publicationCode", " PHB-2014 ");
  formData.set("publicationTitle", " Player's Handbook ");
  formData.set("publisher", " Wizards of the Coast ");
  formData.set("releaseYear", "2014");
  formData.set("revision", " first printing ");
  formData.set("originUrl", " https://example.com/phb ");
  formData.set("originId", " phb-2014 ");
  formData.set("attribution", " Player's Handbook, Wizards of the Coast ");
  formData.set("sourcePriority", "100");
  formData.set("canonicalBookId", "players-handbook");
  formData.set("license", "   ");

  assert.deepEqual(parseUploadSourceMetadata(formData, "Upload title"), {
    canonicalSourceId: "players-handbook-2014-en",
    publication: {
      code: "PHB-2014",
      title: "Player's Handbook",
      publisher: "Wizards of the Coast",
      releaseYear: 2014,
      revision: "first printing",
      origin: { url: "https://example.com/phb", id: "phb-2014" },
      attribution: "Player's Handbook, Wizards of the Coast",
      sourcePriority: 100,
      canonicalBookId: "players-handbook",
    },
    license: null,
  });
});

test("upload metadata rejects malformed stale advanced values", () => {
  const formData = new FormData();
  formData.set("sourcePriority", "high");
  assert.throws(() => parseUploadSourceMetadata(formData, "Rules"), /sourcePriority must be an integer/);
});
