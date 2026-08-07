import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyCandidatePublication, projectSnapshotFlatCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { parseFlatListOptions, parseFlatType } from "../../src/server/compendium/flat-http.ts";
import { FlatReadInputError, FlatReadService } from "../../src/server/compendium/flat-read-service.ts";
import { projectionAttributes, type FlatEntryType } from "../../src/server/compendium/flat-schema.ts";
import { flatCandidate, flatMetadataEvidence, nextDndImportBatch } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import { classifyChunkType } from "../../src/server/compendium/candidate-parsers.ts";
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

test("flat URL filters restore exactly and malformed values fail closed", () => {
  assert.equal(parseFlatType("glossary"), "glossary");
  assert.deepEqual(parseFlatListOptions(new URL("https://example.test/feats?q=alert&category=general&repeatable=false&minLevel=4&maxLevel=8&language=ru")), { query: "alert", entryCategory: "general", repeatable: false, minLevel: 4, maxLevel: 8, language: "ru" });
  assert.throws(() => parseFlatListOptions(new URL("https://example.test/items?attunement=yes")), FlatReadInputError);
});

test("flat list count, filters, relation targets, and cursor remain inside one RBAC boundary", async () => {
  const detail = flatDetailsFixture()[0]; const candidate = flatCandidate(detail as never); const revision = projectSnapshotFlatCandidate(candidate, { candidateKey: "feats-201", entryType: "feat", createdAt: detail.fetchedAt, source, fileId: fileUuid, evidence: evidence(detail) }); const [projection] = projectCanonicalRevisions("flat-fixture", [revision], [{ sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path, mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512 }]); const synced = nfsIndexEntryRow("flat-fixture", projection);
  const row = { ...synced, mime_type: "application/pdf", source_title: source.title, edition: source.edition, language: source.language, publication_code: "NEXT", publication_revision: "2026", source_priority: 10, sort_title: "observant", source_versions: [], relations: [] };
  const statements: string[] = []; const db = { async query(sql: string) { statements.push(sql); return sql.includes("count(*)") ? { rows: [{ count: "2" }] } : { rows: [row, { ...row, entry_id: "feat-feats-202", name: "Second" }] }; } };
  const result = await new FlatReadService(db).list({ role: "user" }, "feat", { entryCategory: "general", repeatable: false, minLevel: 4, limit: 1 });
  assert.equal(result.count, 2); assert.equal(result.entries.length, 1); assert.ok(result.nextCursor); assert.match(statements[0], /s\.access_tier = 'open'/); assert.match(statements[0], /ORDER BY flat\.sort_title COLLATE "C", flat\.entry_id/); assert.doesNotMatch(statements[1], /flat\.sort_title COLLATE "C"[\s\S]*>/);
  const detailStatements: string[] = []; await new FlatReadService({ async query(sql: string) { detailStatements.push(sql); return { rows: [row] }; } }).get({ role: "premium", userId: "33333333-3333-4333-8333-333333333333" }, "feat", row.entry_id);
  assert.match(detailStatements[0], /compendium_import_links evidence/); assert.match(detailStatements[0], /JOIN accessible_flat_versions target/); assert.match(detailStatements[0], /s\.owner_user_id/);
});

test("all flat pages retain concrete RU/EN, mobile, print, citation, and editor contracts", async () => {
  const [list, detail, pages, css, editor, navigation] = await Promise.all([readFile("src/app/flat-compendium/flat-list.tsx", "utf8"), readFile("src/app/flat-compendium/flat-detail.tsx", "utf8"), readFile("src/app/flat-compendium/pages.tsx", "utf8"), readFile("src/app/globals.css", "utf8"), readFile("src/app/admin/compendium/entries/editor-client.tsx", "utf8"), readFile("src/components/ui/navigation.ts", "utf8")]);
  for (const type of ["feat", "background", "item", "equipment", "glossary"] as FlatEntryType[]) { assert.match(list, new RegExp(`${type}: \\[`)); assert.match(editor, new RegExp(`${type}: \\[`)); }
  for (const route of ["feats", "backgrounds", "items", "equipment", "glossary"]) assert.match(navigation, new RegExp(`href: "/${route}"`));
  assert.match(list, /name="language"/); assert.match(list, /name="repeatable"/); assert.match(list, /name="attunement"/); assert.match(detail, /citation\.previewUrl/); assert.match(detail, /citation\.sourceUrl/); assert.match(detail, /entry\.sourceVersions/); assert.match(detail, /entry\.relations/); assert.match(pages, /FlatReadService/); assert.match(css, /@media \(max-width:39\.999rem\)[\s\S]*\.flat-filters/); assert.match(css, /@media print[\s\S]*\.flat-detail section/);
});
