import assert from "node:assert/strict";
import test from "node:test";

import {
  CompendiumService,
  CompendiumValidationError,
  validateCitation,
  validateDraft,
  type CreateCompendiumDraftInput,
} from "../../src/server/compendium/service.ts";

const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  file: "10000000-0000-4000-8000-000000000002",
  chunk: "10000000-0000-4000-8000-000000000003",
  generation: "10000000-0000-4000-8000-000000000004",
  entry: "10000000-0000-4000-8000-000000000005",
  version: "10000000-0000-4000-8000-000000000006",
  revision: "10000000-0000-4000-8000-000000000007",
  target: "10000000-0000-4000-8000-000000000008",
};

const draft: CreateCompendiumDraftInput = {
  canonicalKey: "magic-missile",
  entryType: "spell",
  edition: "5.5e",
  language: "en",
  sourceId: ids.source,
  fileId: ids.file,
  slug: "magic-missile",
  aliases: ["Unerring Darts"],
  title: "Magic Missile",
  body: "Three glowing darts strike their targets.",
  projection: {
    type: "spell",
    level: 1,
    school: "evocation",
    castingTime: "Action",
    range: "120 feet",
    duration: "Instantaneous",
    components: "V, S",
  },
  citations: [{
    chunkId: ids.chunk,
    generationId: ids.generation,
    kind: "field",
    fieldPath: "$.body",
    blockOrder: 0,
    quote: "glowing darts",
    quoteSpanStart: 6,
    quoteSpanEnd: 19,
  }],
};

test("draft validator rejects normalized slug/alias conflicts", () => {
  assert.throws(
    () => validateDraft({ ...draft, aliases: ["Magic Missile"] }),
    /conflict after normalization/,
  );
});

test("projection validators enforce ranges and matching types", () => {
  assert.throws(
    () => validateDraft({ ...draft, projection: { ...draft.projection, level: 10 } }),
    /spell\.level must be an integer between 0 and 9/,
  );
  assert.throws(
    () => validateDraft({ ...draft, projection: { type: "species", size: "medium", speed: 30 } }),
    /Projection type must match entry type/,
  );
  assert.throws(
    () => validateDraft({ ...draft, projection: { ...draft.projection, school: "chronomancy" } as never }),
    /spell\.school must be one of/,
  );
});

test("citation validator uses half-open spans and exact quote snapshots", () => {
  const citation = draft.citations![0];
  validateCitation(citation, "Three glowing darts strike.");
  assert.throws(() => validateCitation(citation, "Three burning darts strike."), /exactly match/);
  assert.throws(() => validateCitation({ ...citation, quoteSpanEnd: 18 }), /length must equal/);
  assert.throws(() => validateCitation({ ...citation, kind: "block", fieldPath: "$.body" }), /cannot have fieldPath/);
});

test("createDraft rejects a source/file corpus boundary mismatch before writes", async () => {
  const service = new CompendiumService(async (callback) => callback({
    async query() {
      return { rows: [{ source_id: ids.source, edition: "5e", language: "en" }] } as never;
    },
  }));
  await assert.rejects(service.createDraft(draft), /edition\/language must match/);
});

test("createDraft writes all records transactionally and validates chunk ownership", async () => {
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM files f JOIN sources")) return { rows: [{ source_id: ids.source, edition: "5.5e", language: "en" }] } as never;
      if (sql.includes("WITH inserted AS")) return { rows: [{ id: ids.entry }] } as never;
      if (sql.includes("INSERT INTO compendium_versions")) return { rows: [{ id: ids.version }] } as never;
      if (sql.includes("INSERT INTO compendium_revisions")) return { rows: [{ id: ids.revision }] } as never;
      if (sql.includes("SELECT quote_text FROM chunks")) return { rows: [{ quote_text: "Three glowing darts strike." }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  assert.deepEqual(await service.createDraft(draft), { entryId: ids.entry, versionId: ids.version, revisionId: ids.revision });
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO compendium_names")).length, 2);
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_spells")));
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_citations")));
});

test("createDraft rejects a citation from another source instead of inserting it", async () => {
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM files f JOIN sources")) return { rows: [{ source_id: ids.source, edition: "5.5e", language: "en" }] } as never;
      if (sql.includes("WITH inserted AS")) return { rows: [{ id: ids.entry }] } as never;
      if (sql.includes("INSERT INTO compendium_versions")) return { rows: [{ id: ids.version }] } as never;
      if (sql.includes("INSERT INTO compendium_revisions")) return { rows: [{ id: ids.revision }] } as never;
      if (sql.includes("SELECT quote_text FROM chunks")) return { rows: [] } as never;
      return { rows: [] } as never;
    },
  }));
  await assert.rejects(service.createDraft(draft), /outside the version source\/file boundary/);
  assert.ok(!statements.some((sql) => sql.includes("INSERT INTO compendium_citations")));
});

test("publishing locks ownership and transitions revision before active pointer", async () => {
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT v.lifecycle")) return { rows: [{ version_lifecycle: "draft", revision_lifecycle: "draft" }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  await service.publishRevision(ids.version, ids.revision);
  assert.match(statements[0], /FOR UPDATE OF v, r/);
  assert.match(statements[1], /UPDATE compendium_revisions SET lifecycle = 'published'/);
  assert.match(statements[2], /active_revision_id = \$2/);
});

test("relations reject cross-edition targets", async () => {
  const service = new CompendiumService(async (callback) => callback({
    async query() {
      return { rows: [{ id: ids.entry, edition: "5e" }, { id: ids.target, edition: "5.5e" }] } as never;
    },
  }));
  await assert.rejects(
    service.createRelation({ sourceEntryId: ids.entry, targetEntryId: ids.target, relationType: "related" }),
    (error: unknown) => error instanceof CompendiumValidationError && /cannot cross editions/.test(error.message),
  );
});
