import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyCandidatePublication, projectSnapshotFlatCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { parseFlatListOptions, parseFlatSelection, parseFlatType } from "../../src/server/compendium/flat-http.ts";
import { FlatNotFoundError, FlatReadInputError, FlatReadService } from "../../src/server/compendium/flat-read-service.ts";
import { compendiumEntryRoute, projectionAttributes, validateFlatProjection, type FlatEntryType } from "../../src/server/compendium/flat-schema.ts";
import { CompendiumReadService } from "../../src/server/compendium/read-service.ts";
import { flatCandidate, flatMetadataEvidence, nextDndImportBatch } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import { classifyChunkType } from "../../src/server/compendium/candidate-parsers.ts";
import { nextDndCardFingerprint } from "../../src/server/compendium/next-dnd/parser.ts";
import { projectCanonicalRevisions } from "../../src/server/content-index/projection.ts";
import { nfsIndexEntryRow } from "../../src/server/content-index/sync.ts";
import { flatDetailsFixture } from "../fixtures/next-dnd/flat-compendium.mts";

const sourceUuid = "11111111-1111-4111-8111-111111111111";
const fileUuid = "22222222-2222-4222-8222-222222222222";
const source = { schemaVersion: 1, kind: "source", sourceId: "next-dnd-flat", title: "Next D&D flat snapshot", category: "official_supplement", edition: "5.5e", language: "ru", accessTier: "open", shared: false, ownerUserId: null, publication: { code: "NEXT", title: "Next D&D", publisher: "next.dnd.su", releaseYear: 2026, revision: "2026-08-07", sourcePriority: 10, canonicalBookId: "next-dnd" }, files: [{ fileId: fileUuid, path: `sources/next-dnd-flat/files/${fileUuid}.snapshot`, mediaType: "application/x-next-dnd-snapshot", contentHash: `sha256:${"d".repeat(64)}` }] } as const;

function evidence(detail: ReturnType<typeof flatDetailsFixture>[number]) {
  const candidate = flatCandidate(detail as never);
  return { sourceUrl: detail.sourceUrl, fingerprintSha256: detail.sha256, rawBlobPath: detail.blobPath, fetchedAt: detail.fetchedAt, fileChecksumSha256: "d".repeat(64), indexUrl: detail.indexSource.url, indexFingerprintSha256: detail.indexSource.fingerprintSha256, rawIndexBlobPath: detail.indexSource.rawBlobPath, indexFetchedAt: detail.indexSource.fetchedAt, indexCardFingerprintSha256: detail.indexSource.cardFingerprintSha256, metadataEvidenceText: candidate.sourceVersion.index.metadataEvidenceText };
}

test("each flat collector fixture crosses review, projection, NFS index, and read contracts", async () => {
  for (const detail of flatDetailsFixture()) {
    const candidate = flatCandidate(detail as never); const snapshotEvidence = evidence(detail);
    const capability = classifyCandidatePublication(candidate, { candidateKey: `${detail.category}-${detail.externalId}`, entryType: candidate.entryType, sourceId: sourceUuid, fileId: fileUuid, generationId: null, edition: "5.5e", language: "ru", accessTier: "open", shared: false, ownerUserId: null, chunk: null, snapshotEvidence });
    assert.equal(capability.publicationCapability, "publishable");
    assert.equal(candidate.citations.length, Object.keys(candidate.attributes).length + 2);
    assert.equal(candidate.citations.every((citation) => citation.fieldPath === "$.title" || citation.fieldPath === "$.body" || snapshotEvidence.metadataEvidenceText.includes(`${citation.fieldPath.split(".").at(-1)}=${citation.quote}`)), true);
    const revision = projectSnapshotFlatCandidate(candidate, { candidateKey: `${detail.category}-${detail.externalId}`, entryType: candidate.entryType, createdAt: detail.fetchedAt, source, fileId: fileUuid, evidence: snapshotEvidence });
    assert.equal(revision.entry.entryType, candidate.entryType);
    assert.equal(revision.text.plain, detail.normalized.contentText);
    assert.equal(revision.citations.every((citation) => citation.page === null && citation.sourceUrl), true);
    const [projection] = projectCanonicalRevisions("flat-fixture", [revision], [{ sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path, mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512 }]);
    assert.equal(projection.entryType, candidate.entryType); assert.equal(projection.pages.length, 0); assert.equal(projection.plainText, detail.normalized.contentText);
    const synced = nfsIndexEntryRow("flat-fixture", projection);
    assert.equal(synced.edition, "5.5e"); assert.equal(synced.language, "ru");
    const row = { ...synced, mime_type: source.files[0].mediaType, source_title: source.title, edition: source.edition, language: source.language, publication_code: source.publication.code, publication_revision: source.publication.revision, source_priority: source.publication.sourcePriority, sort_title: synced.name.toLocaleLowerCase("und"), source_versions: [], relations: [] };
    const mapped = await new FlatReadService({ async query() { return { rows: [row] }; } }).get({ role: "user" }, candidate.entryType, synced.entry_id);
    assert.equal(mapped.entryType, candidate.entryType); assert.equal(mapped.title, detail.normalized.title); assert.deepEqual(projectionAttributes(mapped.projection), candidate.attributes); assert.equal(mapped.citations.length, candidate.citations.length);
    assert.equal(mapped.citations.every((citation) => citation.previewUrl === null && citation.sourceUrl?.startsWith("https://next.dnd.su/")), true);
  }
});

test("flat import adapter emits typed candidates and immutable evidence without raw publication", () => {
  const details = flatDetailsFixture(); const manifest = { schemaVersion: 2, parserVersion: "next-dnd-2024-v3", status: "complete", collectedAt: details[0].fetchedAt, robots: { userAgent: "fixture", snapshot: {}, rules: [], evaluations: [] }, parserFailures: [], diagnostics: [], categories: details.map((detail) => ({ requestedCategory: detail.category, discoveredCategory: detail.category, entryCount: 1, index: {}, details: [detail] })) } as never;
  const batch = nextDndImportBatch(manifest);
  assert.equal(batch.candidates.length, 5); assert.equal(batch.occurrences.every((item) => item.metadataEvidenceText?.startsWith("window.LIST flat projection")), true);
  assert.equal(batch.candidates.every((item) => (item.content as { kind: string }).kind === "snapshotFlatCandidate"), true);
  const raw = { ...batch.candidates[0].content as object, kind: undefined };
  assert.equal(classifyCandidatePublication(raw, { candidateKey: "feats-201", entryType: "feat", sourceId: sourceUuid, fileId: fileUuid, generationId: null, edition: "5.5e", language: "ru", accessTier: "open", shared: false, ownerUserId: null, chunk: null }).publicationCapability, "requires_extraction");
});

test("PDF extraction classifies every flat type before schema-and-citation-checked LLM transform", () => {
  const expected = ["feat", "background", "item", "equipment", "glossary"];
  assert.deepEqual(flatDetailsFixture().map((detail) => classifyChunkType(detail.normalized.contentText)), expected);
});

test("forged collector provenance and field citations cannot cross review", () => {
  const detail = flatDetailsFixture()[2]; const candidate = structuredClone(flatCandidate(detail as never)); const forged = "f".repeat(64);
  candidate.sha256 = forged; candidate.sourceVersion = { ...candidate.sourceVersion, sha256: forged, rawBlobPath: `blobs/${forged}.html` };
  const capability = classifyCandidatePublication(candidate, { candidateKey: "items-401", entryType: "item", sourceId: sourceUuid, fileId: fileUuid, generationId: null, edition: "5.5e", language: "ru", accessTier: "open", shared: false, ownerUserId: null, chunk: null, snapshotEvidence: evidence(detail) });
  assert.equal(capability.publicationCapability, "requires_extraction"); assert.match(capability.publicationBlockReason!, /persisted occurrence/);
  assert.equal(flatMetadataEvidence(candidate.attributes), evidence(detail).metadataEvidenceText);
});

test("approval and NFS roundtrip omit null-only feat and equipment fields and citations", async () => {
  for (const [fixtureIndex, typedFields, omitted] of [
    [0, { category: "general", prerequisiteLevel: null, prerequisiteText: null, repeatable: false }, ["prerequisiteLevel", "prerequisiteText"]],
    [3, { category: "adventuring_gear", costCp: null, weightLb: null }, ["costCp", "weightLb"]],
  ] as const) {
    const base = flatDetailsFixture()[fixtureIndex];
    const indexMetadata = { ...base.indexMetadata, typed_fields: typedFields };
    const detail = { ...base, indexMetadata, indexSource: { ...base.indexSource, cardFingerprintSha256: nextDndCardFingerprint(indexMetadata) } };
    const candidate = flatCandidate(detail as never); const snapshotEvidence = evidence(detail as never);
    assert.equal(classifyCandidatePublication(candidate, { candidateKey: `${detail.category}-${detail.externalId}`, entryType: candidate.entryType, sourceId: sourceUuid, fileId: fileUuid, generationId: null, edition: "5.5e", language: "ru", accessTier: "open", shared: false, ownerUserId: null, chunk: null, snapshotEvidence }).publicationCapability, "publishable");
    for (const field of omitted) { assert.equal(Object.hasOwn(candidate.attributes, field), false); assert.equal(candidate.citations.some((citation) => citation.fieldPath === `$.attributes.${field}`), false); }
    const revision = projectSnapshotFlatCandidate(candidate, { candidateKey: `${detail.category}-${detail.externalId}`, entryType: candidate.entryType, createdAt: detail.fetchedAt, source, fileId: fileUuid, evidence: snapshotEvidence });
    for (const field of omitted) assert.equal(revision.entry.typedFields.some((item) => item.key === field.replace(/([A-Z])/g, "-$1").toLowerCase()), false);
    const [projection] = projectCanonicalRevisions("flat-null-fixture", [revision], [{ sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path, mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512 }]);
    const synced = nfsIndexEntryRow("flat-null-fixture", projection); const row = { ...synced, mime_type: source.files[0].mediaType, source_title: source.title, publication_code: source.publication.code, publication_revision: source.publication.revision, source_priority: source.publication.sourcePriority, sort_title: synced.name.toLocaleLowerCase("und"), source_versions: [], relations: [] };
    const mapped = await new FlatReadService({ async query() { return { rows: [row] }; } }).get({ role: "user" }, candidate.entryType, synced.entry_id, { edition: "5.5e", language: "ru" });
    for (const field of omitted) assert.equal((mapped.projection as unknown as Record<string, unknown>)[field], null);
  }
});

test("flat URL filters restore exactly and malformed values fail closed", () => {
  assert.equal(parseFlatType("glossary"), "glossary");
  assert.deepEqual(parseFlatListOptions(new URL("https://example.test/feats?q=alert&category=general&repeatable=false&minLevel=4&maxLevel=8&language=ru")), { query: "alert", entryCategory: "general", repeatable: false, minLevel: 4, maxLevel: 8, language: "ru" });
  assert.throws(() => parseFlatListOptions(new URL("https://example.test/items?attunement=yes")), FlatReadInputError);
  assert.deepEqual(parseFlatSelection(new URL("https://example.test/equipment/rope?edition=5.5e&language=ru")), { edition: "5.5e", language: "ru" });
  assert.throws(() => parseFlatSelection(new URL("https://example.test/equipment/rope?edition=2024")), FlatReadInputError);
});

test("background fields are normalized lists and equipment weight matches numeric(10,3)", () => {
  assert.deepEqual(validateFlatProjection("background", { abilityScores: [" Dexterity ", "Wisdom", "Dexterity"], skillProficiencies: ["Stealth"] }), { type: "background", abilityScores: ["Dexterity", "Wisdom"], skillProficiencies: ["Stealth"] });
  assert.throws(() => validateFlatProjection("background", { abilityScores: "Dexterity, Wisdom", skillProficiencies: "Stealth" }), /text list/);
  assert.equal(validateFlatProjection("equipment", { category: "tool", costCp: 1, weightLb: 1.001 }).weightLb, 1.001);
  assert.throws(() => validateFlatProjection("equipment", { category: "tool", costCp: 1, weightLb: 1.0001 }), /numeric\(10,3\)/);
});

test("collector equipment metadata enforces numeric(10,3) before canonical publication", () => {
  const base = flatDetailsFixture()[3];
  const detail = (weightLb: number) => {
    const indexMetadata = { ...base.indexMetadata, typed_fields: { category: "tool", costCp: 1, weightLb } };
    return { ...base, indexMetadata, indexSource: { ...base.indexSource, cardFingerprintSha256: nextDndCardFingerprint(indexMetadata) } };
  };
  assert.equal(flatCandidate(detail(1.001) as never).attributes.weightLb, 1.001);
  assert.throws(() => flatCandidate(detail(1.0001) as never), /numeric\(10,3\)/);
});

test("background filters use individually indexable JSONB list containment", async () => {
  const calls: unknown[][] = [];
  await new FlatReadService({ async query(sql: string, values: readonly unknown[] = []) { calls.push([...values]); return sql.includes("count(*)") ? { rows: [{ count: "0" }] } : { rows: [] }; } }).list(
    { role: "user" }, "background", { ability: "Dexterity", skill: "Stealth" },
  );
  assert.ok(calls[0].includes(JSON.stringify([{ key: "ability-scores", value: ["Dexterity"] }])));
  assert.ok(calls[0].includes(JSON.stringify([{ key: "skill-proficiencies", value: ["Stealth"] }])));
});

test("flat list count, filters, relation targets, and cursor remain inside one RBAC boundary", async () => {
  const detail = flatDetailsFixture()[0]; const candidate = flatCandidate(detail as never); const revision = projectSnapshotFlatCandidate(candidate, { candidateKey: "feats-201", entryType: "feat", createdAt: detail.fetchedAt, source, fileId: fileUuid, evidence: evidence(detail) }); const [projection] = projectCanonicalRevisions("flat-fixture", [revision], [{ sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path, mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512 }]); const synced = nfsIndexEntryRow("flat-fixture", projection);
  const row = { ...synced, mime_type: "application/pdf", source_title: source.title, edition: source.edition, language: source.language, publication_code: "NEXT", publication_revision: "2026", source_priority: 10, sort_title: "observant", source_versions: [], relations: [] };
  const statements: string[] = []; const db = { async query(sql: string) { statements.push(sql); return sql.includes("count(*)") ? { rows: [{ count: "2" }] } : { rows: [row, { ...row, entry_id: "feat-feats-202", name: "Second" }] }; } };
  const result = await new FlatReadService(db).list({ role: "user" }, "feat", { entryCategory: "general", repeatable: false, minLevel: 4, limit: 1 });
  assert.equal(result.count, 2); assert.equal(result.entries.length, 1); assert.ok(result.nextCursor);
  assert.deepEqual(JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString()), { v: 1, edition: "5.5e", language: "ru", title: "observant", id: row.entry_id });
  assert.match(statements[0], /s\.access_tier = 'open'/); assert.match(statements[0], /PARTITION BY n\.entry_id, n\.edition, n\.language/); assert.match(statements[0], /indexed\.typed_fields @>/); assert.match(statements[0], /nfs_index_typed_number\(indexed\.typed_fields/); assert.match(statements[0], /ORDER BY indexed\.edition, indexed\.language, lower\(indexed\.name\) COLLATE "C", indexed\.entry_id/); assert.doesNotMatch(statements[1], /lower\(indexed\.name\) COLLATE "C"[\s\S]*>/);
  const detailStatements: string[] = []; await new FlatReadService({ async query(sql: string) { detailStatements.push(sql); return { rows: [row] }; } }).get({ role: "premium", userId: "33333333-3333-4333-8333-333333333333" }, "feat", row.entry_id);
  assert.match(detailStatements[0], /compendium_import_links evidence JOIN accessible_relation_evidence authorized/); assert.match(detailStatements[0], /accessible_relation_versions AS MATERIALIZED/); assert.match(detailStatements[0], /PARTITION BY n\.entry_id, n\.source_id, n\.file_id, n\.edition, n\.language/); assert.match(detailStatements[0], /accessible_relation_evidence AS MATERIALIZED/); assert.match(detailStatements[0], /accessible_relational_targets AS MATERIALIZED/); assert.match(detailStatements[0], /LEFT JOIN accessible_relation_versions nfs_target/); assert.match(detailStatements[0], /relational_target\.source_id = flat\.source_id AND relational_target\.file_id = flat\.file_id/); assert.match(detailStatements[0], /authorized\.source_id = flat\.source_id AND authorized\.file_id = flat\.file_id/); assert.match(detailStatements[0], /CASE WHEN relational_target\.entry_type::text IN .* THEN nfs_target\.entry_id ELSE relational_target\.entry_id::text END/); assert.match(detailStatements[0], /CASE WHEN flat\.entry_id .* THEN 0 ELSE 1 END AS identifier_rank/); assert.match(detailStatements[0], /count\(\*\) OVER \(\) AS match_count/); assert.match(detailStatements[0], /flat\.match_count = 1/); assert.match(detailStatements[0], /s\.owner_user_id/);
});

test("relation route map covers dedicated and generic compendium targets", () => {
  const selection = { edition: "5.5e", language: "ru" } as const;
  assert.equal(compendiumEntryRoute("spell", "spell-shield", selection), "/spells/spell-shield?edition=5.5e&language=ru");
  assert.equal(compendiumEntryRoute("glossary", "glossary-cover", selection), "/glossary/glossary-cover?edition=5.5e&language=ru");
  for (const type of ["creature", "class", "feature", "species", "monster", "classFeature", "other"]) assert.equal(compendiumEntryRoute(type, `${type}-id`, selection), `/ru/compendium/entries/${type}-id?edition=5.5e&language=ru`);
});

test("generic flat relation UUID resolves through the generic reader in the exact accessible variant", async () => {
  const targetId = "44444444-4444-4444-8444-444444444444";
  const base = flatDetailsFixture()[0]; const candidate = flatCandidate(base as never);
  const revision = projectSnapshotFlatCandidate(candidate, { candidateKey: "feats-201", entryType: "feat", createdAt: base.fetchedAt, source, fileId: fileUuid, evidence: evidence(base) });
  const [projection] = projectCanonicalRevisions("flat-relation", [revision], [{ sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path, mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512 }]);
  const synced = nfsIndexEntryRow("flat-relation", projection);
  const flatRow = { ...synced, mime_type: source.files[0].mediaType, source_title: source.title, publication_code: source.publication.code, publication_revision: source.publication.revision, source_priority: 10, sort_title: "observant", source_versions: [], relations: [{ type: "references", direction: "outgoing", entryId: targetId, entryType: "creature", title: "Goblin" }] };
  let flatSql = "";
  const flat = await new FlatReadService({ async query(sql: string) { flatSql = sql; return { rows: [flatRow] }; } }).get({ role: "user" }, "feat", synced.entry_id, { edition: "5.5e", language: "ru" });
  assert.equal(flat.relations[0].entryId, targetId);
  assert.equal(compendiumEntryRoute(flat.relations[0].entryType, flat.relations[0].entryId, flat), `/ru/compendium/entries/${targetId}?edition=5.5e&language=ru`);
  assert.match(flatSql, /relational_target\.source_id = flat\.source_id/); assert.match(flatSql, /authorized\.edition = flat\.edition AND authorized\.language = flat\.language/); assert.match(flatSql, /s\.access_tier = 'open'/);

  let genericValues: readonly unknown[] = [];
  const generic = new CompendiumReadService({ async query(_sql: string, values: readonly unknown[] = []) { genericValues = values; return { rows: [{ entry_id: targetId, canonical_key: "goblin", entry_type: "creature", edition: "5.5e", language: "ru", version_id: "55555555-5555-4555-8555-555555555555", revision_id: "66666666-6666-4666-8666-666666666666", slug: "goblin", aliases: [], title: "Goblin", summary: null, body: "A goblin.", extension_data: {}, projection: {}, relations: [], sources: [], citations: [], source_id: sourceUuid, source_title: "Open Rules", source_category: "core_rules", publication_code: "SRD", publication_title: "Open Rules", publisher: null, release_year: 2024, publication_revision: null, external_origin_url: null, attribution: null, license: null }] } as never; } });
  const resolved = await generic.getEntry({ role: "user" }, flat.relations[0].entryId, { edition: flat.edition as "5.5e", language: flat.language as "ru" });
  assert.equal(resolved.id, targetId); assert.equal(resolved.slug, "goblin"); assert.ok(genericValues.includes(targetId)); assert.ok(genericValues.includes("5.5e")); assert.ok(genericValues.includes("ru"));

  const hidden = await new FlatReadService({ async query() { return { rows: [{ ...flatRow, relations: [] }] }; } }).get({ role: "user" }, "feat", synced.entry_id, { edition: "5.5e", language: "ru" });
  assert.deepEqual(hidden.relations, []);
});

test("detail identity SQL prioritizes exact IDs and rejects ambiguous aliases", async () => {
  let sql = "";
  await assert.rejects(new FlatReadService({ async query(statement: string) { sql = statement; return { rows: [] }; } }).get({ role: "user" }, "glossary", "shared-alias"), FlatNotFoundError);
  assert.match(sql, /CASE WHEN flat\.entry_id = \$\d+ THEN 0 ELSE 1 END AS identifier_rank/);
  assert.match(sql, /min\(identifier_rank\) OVER \(\) AS best_rank/);
  assert.match(sql, /count\(\*\) OVER \(\) AS match_count/);
  assert.match(sql, /WHERE flat\.match_count = 1/);
});

test("all flat pages retain concrete RU/EN, mobile, print, citation, and editor contracts", async () => {
  const [list, detail, pages, css, editor, navigation] = await Promise.all([readFile("src/app/flat-compendium/flat-list.tsx", "utf8"), readFile("src/app/flat-compendium/flat-detail.tsx", "utf8"), readFile("src/app/flat-compendium/pages.tsx", "utf8"), readFile("src/app/globals.css", "utf8"), readFile("src/app/admin/compendium/entries/editor-client.tsx", "utf8"), readFile("src/components/ui/navigation.ts", "utf8")]);
  for (const type of ["feat", "background", "item", "equipment", "glossary"] as FlatEntryType[]) { assert.match(list, new RegExp(`${type}: \\[`)); assert.match(editor, new RegExp(`${type}: \\[`)); }
  for (const route of ["feats", "backgrounds", "items", "equipment", "glossary"]) assert.match(navigation, new RegExp(`href: "/${route}"`));
  assert.match(list, /name="language"/); assert.match(list, /entry\.edition.*entry\.language.*entry\.id/); assert.match(list, /name="repeatable"/); assert.match(list, /name="attunement"/); assert.match(detail, /requiresAttunement: \["Требует настройки", "Requires attunement"\]/); assert.match(detail, /edition: entry\.edition, language: entry\.language/); assert.match(detail, /value \? "Да" : "Нет"/); assert.match(detail, /citation\.previewUrl/); assert.match(detail, /citation\.sourceUrl/); assert.match(detail, /entry\.sourceVersions/); assert.match(detail, /entry\.relations/); assert.match(pages, /notFound\(\)/); assert.match(pages, /parseFlatSelection/); assert.match(css, /@media \(max-width:39\.999rem\)[\s\S]*\.flat-filters/); assert.match(css, /@media print[\s\S]*\.flat-detail section/);
});
