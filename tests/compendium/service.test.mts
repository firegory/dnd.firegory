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
  assert.throws(
    () => validateDraft({ ...draft, slug: "cafe", aliases: ["caf\u00e9", "cafe\u0301"] }),
    /conflict after normalization/,
  );
  assert.throws(() => validateDraft({ ...draft, aliases: ["I", "i"] }), /conflict after normalization/);
  assert.throws(() => validateDraft({ ...draft, aliases: ["\u0130", "i\u0307"] }), /conflict after normalization/);
  assert.throws(() => validateDraft({ ...draft, aliases: ["\u041c\u0410\u0413", "\u043c\u0430\u0433"] }), /conflict after normalization/);
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
  assert.throws(() => validateCitation({ ...citation, quoteSpanEnd: 18 }), /code-point length must equal/);
  assert.throws(() => validateCitation({ ...citation, kind: "block", fieldPath: "$.body" }), /cannot have fieldPath/);
  validateCitation({ ...citation, quote: "glowing \ud83c\udfaf", quoteSpanStart: 2, quoteSpanEnd: 11 }, "\ud83d\udca5 glowing \ud83c\udfaf now");
  assert.throws(
    () => validateCitation({ ...citation, quote: "glowing \ud83c\udfaf", quoteSpanStart: 3, quoteSpanEnd: 12 }, "\ud83d\udca5 glowing \ud83c\udfaf now"),
    /exactly match/,
  );
});

test("projection numeric validators match PostgreSQL precision and integer bounds", () => {
  const creature = { type: "creature", size: "medium", creatureType: "beast", armorClass: 12, hitPoints: 10, challengeRating: 0.125, speed: "30 ft." } as const;
  assert.doesNotThrow(() => validateDraft({ ...draft, entryType: "creature", projection: creature }));
  assert.throws(() => validateDraft({ ...draft, entryType: "creature", projection: { ...creature, challengeRating: 0.13 } }), /challengeRating/);
  assert.throws(() => validateDraft({ ...draft, entryType: "creature", projection: { ...creature, hitPoints: 2147483648 } }), /2147483647/);
  const equipment = { type: "equipment", category: "tool", costCp: 2147483647, weightLb: 9999999.999 } as const;
  assert.doesNotThrow(() => validateDraft({ ...draft, entryType: "equipment", projection: equipment }));
  for (const weightLb of [0, 0.001, 1.001, 1.005, 1.015, 9999999.999]) {
    assert.doesNotThrow(() => validateDraft({ ...draft, entryType: "equipment", projection: { ...equipment, weightLb } }));
  }
  assert.throws(() => validateDraft({ ...draft, entryType: "equipment", projection: { ...equipment, costCp: 2147483648 } }), /2147483647/);
  for (const weightLb of [0.0001, 1.0001, 1.0015, 9999999.9989]) {
    assert.throws(() => validateDraft({ ...draft, entryType: "equipment", projection: { ...equipment, weightLb } }), /at most 3 decimal places/);
  }
  assert.throws(() => validateDraft({ ...draft, entryType: "equipment", projection: { ...equipment, weightLb: 10000000 } }), /9999999\.999/);
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
      if (sql.includes("INSERT INTO compendium_entries")) return { rows: [{ id: ids.entry }] } as never;
      if (sql.includes("INSERT INTO compendium_versions")) return { rows: [{ id: ids.version, active_revision_id: ids.revision }] } as never;
      if (sql.includes("INSERT INTO compendium_revisions")) return { rows: [{ id: ids.revision }] } as never;
      if (sql.includes("SELECT c.quote_text")) return { rows: [{ quote_text: "Three glowing darts strike.", generation_status: "active" }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  assert.deepEqual(await service.createDraft(draft), { entryId: ids.entry, versionId: ids.version, revisionId: ids.revision });
  assert.equal(statements.filter((sql) => sql.includes("INSERT INTO compendium_names")).length, 2);
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_spells")));
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_citations")));
  assert.ok(statements.some((sql) => sql.includes("g.status IN ('active', 'archived')") && sql.includes("FOR SHARE OF c, g")));
  const entryStatement = statements.find((sql) => sql.includes("INSERT INTO compendium_entries"))!;
  assert.match(entryStatement, /ON CONFLICT[\s\S]*DO UPDATE[\s\S]*RETURNING id/);
  assert.doesNotMatch(entryStatement, /DO NOTHING/);
  assert.ok(statements.some((sql) => /active_revision_id\)[\s\S]*gen_random_uuid/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO compendium_revisions[\s\S]*\(id, version_id/.test(sql)));
});

test("createDraft rejects a citation from another source instead of inserting it", async () => {
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM files f JOIN sources")) return { rows: [{ source_id: ids.source, edition: "5.5e", language: "en" }] } as never;
      if (sql.includes("INSERT INTO compendium_entries")) return { rows: [{ id: ids.entry }] } as never;
      if (sql.includes("INSERT INTO compendium_versions")) return { rows: [{ id: ids.version, active_revision_id: ids.revision }] } as never;
      if (sql.includes("INSERT INTO compendium_revisions")) return { rows: [{ id: ids.revision }] } as never;
      if (sql.includes("SELECT c.quote_text")) return { rows: [] } as never;
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
      if (sql.includes("SELECT g.status")) return { rows: [{ status: "archived" }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  await service.publishRevision(ids.version, ids.revision);
  assert.match(statements[0], /FOR UPDATE OF v, r/);
  assert.match(statements[1], /FOR SHARE OF g/);
  assert.match(statements[2], /compendium_import_links/);
  assert.match(statements[3], /UPDATE compendium_revisions SET lifecycle = 'published'/);
  assert.match(statements[4], /active_revision_id = \$2/);
});

test("publishing rejects and transactionally locks staged citation generations", async () => {
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      if (sql.includes("SELECT v.lifecycle")) return { rows: [{ version_lifecycle: "draft", revision_lifecycle: "draft" }] } as never;
      if (sql.includes("SELECT g.status")) return { rows: [{ status: "staged" }] } as never;
      return { rows: [] } as never;
    },
  }));
  await assert.rejects(service.publishRevision(ids.version, ids.revision), /active or archived generations/);
});

test("publishing rejects revisions backed by failed or partial imports", async () => {
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      if (sql.includes("SELECT v.lifecycle")) return { rows: [{ version_lifecycle: "draft", revision_lifecycle: "draft" }] } as never;
      if (sql.includes("SELECT g.status")) return { rows: [{ status: "active" }] } as never;
      if (sql.includes("SELECT run.status")) return { rows: [{ status: "running" }] } as never;
      return { rows: [] } as never;
    },
  }));
  await assert.rejects(service.publishRevision(ids.version, ids.revision), /Failed or partial import runs/);
});

test("new revisions replace draft active content instead of mutating children", async () => {
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM compendium_versions WHERE")) return { rows: [{ entry_type: "spell", lifecycle: "draft", source_id: ids.source, file_id: ids.file }] } as never;
      if (sql.includes("coalesce(max(revision_number)")) return { rows: [{ revision_number: 2 }] } as never;
      if (sql.includes("INSERT INTO compendium_revisions")) return { rows: [{ id: ids.target }] } as never;
      return { rows: [], rowCount: 1 } as never;
    },
  }));
  const revisionId = await service.createRevision(ids.version, { title: draft.title, body: draft.body, projection: draft.projection });
  assert.equal(revisionId, ids.target);
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_spells")));
  assert.ok(statements.some((sql) => sql.includes("UPDATE compendium_versions SET active_revision_id")));
  assert.ok(!statements.some((sql) => /^UPDATE compendium_(?:spells|citations)/.test(sql)));
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
