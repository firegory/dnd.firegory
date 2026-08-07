import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyCandidatePublication, projectSnapshotSpellCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { parseSpellListOptions } from "../../src/server/compendium/spell-http.ts";
import { spellCandidate } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import { SpellReadInputError, SpellReadService } from "../../src/server/compendium/spell-read-service.ts";
import { validateSpellProjection } from "../../src/server/compendium/spell-schema.ts";
import { projectCanonicalRevisions } from "../../src/server/content-index/projection.ts";
import { nfsIndexEntryRow } from "../../src/server/content-index/sync.ts";
import { spellDetailsFixture } from "../fixtures/next-dnd/spells.mts";

const sourceUuid = "11111111-1111-4111-8111-111111111111";
const fileUuid = "22222222-2222-4222-8222-222222222222";
const source = {
  schemaVersion: 1, kind: "source", sourceId: "next-dnd-snapshot", title: "Next D&D snapshot",
  category: "official_supplement", edition: "5.5e", language: "ru", accessTier: "open",
  shared: false, ownerUserId: null,
  publication: {
    code: "NEXT", title: "Next D&D", publisher: "next.dnd.su", releaseYear: 2026,
    revision: "2026-08-06", sourcePriority: 10, canonicalBookId: "next-dnd",
  },
  files: [{ fileId: fileUuid, path: `sources/next-dnd-snapshot/files/${fileUuid}.snapshot`, mediaType: "application/x-next-dnd-snapshot", contentHash: `sha256:${"d".repeat(64)}` }],
} as const;

const detail = {
  category: "spells", externalId: "10195", sourceUrl: "https://next.dnd.su/spells/10195-hunters-mark",
  finalUrl: "https://next.dnd.su/spells/10195-hunters-mark", redirectChain: [],
  fetchedAt: "2026-08-06T12:00:00.000Z", sha256: "a".repeat(64), byteLength: 512,
  parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${"a".repeat(64)}.html`, kind: "detail",
  normalized: {
    title: "Метка охотника", contentHtml: "<article>Метка охотника</article>",
    contentText: "Casting Time: 1 bonus action. Range: 90 feet. Components: V. Duration: Concentration, up to 1 hour. Mark one creature you can see.",
  },
  indexMetadata: {
    level: 1, school: "Прорицание", title_en: "Hunter's Mark", filter_class: [17],
    item_tags: { concentration: { tag_value: "C" } },
  },
} as const;

test("collector spell becomes a cited canonical candidate and NFS database projection", () => {
  const candidate = spellCandidate(detail as never);
  assert.equal(candidate.extraction.status, "ready");
  assert.deepEqual(candidate.aliases, ["Hunter's Mark"]);
  assert.deepEqual(candidate.attributes, {
    level: 1, school: "divination", castingTime: "1 bonus action.", range: "90 feet.",
    duration: "Concentration, up to 1 hour.", components: "V.", concentration: true,
    ritual: false, classes: ["class:17"],
  });
  assert.ok(candidate.citations.some((citation) => citation.fieldPath === "$.body"));

  const revision = projectSnapshotSpellCandidate(candidate, {
    candidateKey: "spells-10195", createdAt: "2026-08-06T12:01:00.000Z", source, fileId: fileUuid,
    evidence: {
      sourceUrl: detail.sourceUrl, fingerprintSha256: detail.sha256, rawBlobPath: detail.blobPath,
      fetchedAt: detail.fetchedAt, fileChecksumSha256: "d".repeat(64),
    },
  });
  assert.equal(revision.entryId, "spell-spells-10195");
  assert.equal(revision.entry.entryType, "spell");
  assert.equal(revision.citations.length, 11);
  assert.equal(revision.citations.every((citation) => citation.page === null && citation.sourceUrl === detail.sourceUrl), true);
  assert.equal(revision.sourceVersion?.fileChecksumSha256, "d".repeat(64));

  const [projection] = projectCanonicalRevisions("fixture", [revision], [{
    sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path,
    mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512,
  }]);
  assert.equal(projection.entryId, revision.entryId);
  assert.deepEqual(projection.aliases, ["Hunter's Mark"]);
  assert.equal(projection.typedFields.length, 9);
  assert.equal(projection.pages.length, 0, "external evidence never fabricates a PDF page");
  assert.equal(projection.chunks[0].pageNumber, null);
});

test("spell schema rejects incomplete typed collector output", () => {
  assert.throws(() => validateSpellProjection({ level: 10 }), /level must be an integer/i);
  const incomplete = spellCandidate({ ...detail, normalized: { ...detail.normalized, contentText: "Rules only." } } as never);
  assert.equal(incomplete.extraction.status, "needs_review");
  assert.ok(incomplete.extraction.missingFields.includes("castingTime"));
});

test("self-consistent submitted provenance cannot replace persisted occurrence or file evidence", () => {
  const candidate = structuredClone(spellCandidate(detail as never));
  const attackerHash = "e".repeat(64);
  candidate.sourceUrl = "https://next.dnd.su/spells/99999-forged";
  candidate.sha256 = attackerHash;
  candidate.sourceVersion = {
    url: candidate.sourceUrl, sha256: attackerHash, rawBlobPath: `blobs/${attackerHash}.html`, fetchedAt: candidate.sourceVersion.fetchedAt,
  };
  candidate.citations = candidate.citations.map((citation) => ({ ...citation, sourceUrl: candidate.sourceUrl }));
  const capability = classifyCandidatePublication(candidate, {
    candidateKey: "spells-10195", entryType: "spell", sourceId: sourceUuid, fileId: fileUuid, generationId: null,
    edition: "5.5e", language: "ru", accessTier: "open", shared: false, ownerUserId: null, chunk: null,
    snapshotEvidence: { sourceUrl: detail.sourceUrl, fingerprintSha256: detail.sha256, rawBlobPath: detail.blobPath,
      fetchedAt: detail.fetchedAt, fileChecksumSha256: "d".repeat(64) },
  });
  assert.equal(capability.publicationCapability, "requires_extraction");
  assert.match(capability.publicationBlockReason!, /persisted occurrence/);
});

test("all 411 collector records transform with database-bound field evidence", () => {
  const details = spellDetailsFixture();
  const revisions = details.map((record) => {
    const candidate = spellCandidate(record);
    const evidence = {
      sourceUrl: record.sourceUrl, fingerprintSha256: record.sha256, rawBlobPath: record.blobPath,
      fetchedAt: record.fetchedAt, fileChecksumSha256: "d".repeat(64),
    };
    assert.equal(classifyCandidatePublication(candidate, {
      candidateKey: `spells-${record.externalId}`, entryType: "spell", sourceId: sourceUuid, fileId: fileUuid,
      generationId: null, edition: "5.5e", language: "ru", accessTier: "open", shared: false,
      ownerUserId: null, chunk: null, snapshotEvidence: evidence,
    }).publicationCapability, "publishable");
    return projectSnapshotSpellCandidate(candidate, {
      candidateKey: `spells-${record.externalId}`, createdAt: record.fetchedAt, source, fileId: fileUuid, evidence,
    });
  });
  assert.equal(revisions.length, 411);
  assert.equal(revisions.every((revision) => revision.citations.length === 11 && revision.sourceVersion), true);
  const projections = projectCanonicalRevisions("fixture-411", revisions, [{
    sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path,
    mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 4096,
  }]);
  assert.equal(projections.length, 411);
  assert.equal(projections.every((projection) => projection.pages.length === 0 && projection.chunks[0].pageNumber === null), true);
});

test("all typed filters restore from URL and reject malformed values", () => {
  const url = new URL("https://example.test/spells?level=1&level=3&school=divination&ritual=true&concentration=false&class=class%3A17&casting=bonus&range=90+feet&duration=hour&component=V&component=S&language=ru");
  assert.deepEqual(parseSpellListOptions(url), {
    language: "ru", levels: [1, 3], schools: ["divination"], ritual: true, concentration: false,
    className: "class:17", castingTime: "bonus", range: "90 feet", duration: "hour", components: ["V", "S"],
  });
  assert.throws(() => parseSpellListOptions(new URL("https://example.test/spells?ritual=yes")), SpellReadInputError);
});

test("RBAC, filtered counts, source versions, and keyset cursor share one boundary", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const row = spellRow();
  const db = { async query(sql: string, values: readonly unknown[] = []) {
    statements.push({ sql, values });
    if (sql.includes("count(*)")) return { rows: [{ count: "2" }] };
    return { rows: [row, { ...row, entry_id: "spell-spells-10196", name: "Метка охотника 2" }] };
  } };
  const result = await new SpellReadService(db).list({ role: "user" }, {
    levels: [1], schools: ["divination"], ritual: false, concentration: true,
    className: "class:17", castingTime: "bonus", range: "90", duration: "hour", components: ["V"], limit: 1,
  });
  assert.equal(result.count, 2);
  assert.equal(result.spells.length, 1);
  assert.ok(result.nextCursor);
  assert.match(statements[0].sql, /s\.access_tier = 'open'/);
  assert.match(statements[0].sql, /source_rank = 1/);
  assert.match(statements[0].sql, /casting-time/);
  assert.match(statements[0].sql, /ORDER BY spell\.sort_title COLLATE "C", spell\.entry_id/);
  assert.doesNotMatch(statements[1].sql, /spell\.sort_title COLLATE "C"[\s\S]*>/, "total count is independent of page cursor");

  const nextStatements: string[] = [];
  const nextDb = { async query(sql: string) {
    nextStatements.push(sql);
    return sql.includes("count(*)") ? { rows: [{ count: "2" }] } : { rows: [row] };
  } };
  await new SpellReadService(nextDb).list({ role: "premium", userId: "33333333-3333-4333-8333-333333333333" }, { cursor: result.nextCursor!, limit: 1 });
  assert.match(nextStatements[0], /spell\.sort_title COLLATE "C"[\s\S]*>/);
  assert.doesNotMatch(nextStatements[1], /spell\.sort_title COLLATE "C"[\s\S]*>/);
  assert.match(nextStatements[0], /s\.owner_user_id/);
});

test("real NFS projection sync rows map through the spell service contract", async () => {
  const candidate = spellCandidate(detail as never);
  const revision = projectSnapshotSpellCandidate(candidate, {
    candidateKey: "spells-10195", createdAt: "2026-08-06T12:01:00.000Z", source, fileId: fileUuid,
    evidence: { sourceUrl: detail.sourceUrl, fingerprintSha256: detail.sha256, rawBlobPath: detail.blobPath,
      fetchedAt: detail.fetchedAt, fileChecksumSha256: "d".repeat(64) },
  });
  const [projection] = projectCanonicalRevisions("fixture", [revision], [{
    sourceId: source.sourceId, fileId: fileUuid, path: source.files[0].path,
    mediaType: source.files[0].mediaType, contentHash: source.files[0].contentHash, byteSize: 512,
  }]);
  const synced = nfsIndexEntryRow("fixture", projection);
  const row = {
    ...synced, mime_type: source.files[0].mediaType, source_title: source.title, edition: source.edition,
    language: source.language, publication_code: source.publication.code, publication_revision: source.publication.revision,
    source_priority: source.publication.sourcePriority, sort_title: synced.name.toLocaleLowerCase("und"),
    source_versions: [{ sourceId: synced.source_id, title: source.title, code: source.publication.code,
      revision: source.publication.revision, revisionId: synced.revision_id }],
  };
  let detailSql = "";
  const service = new SpellReadService({ async query(sql: string) { detailSql = sql; return { rows: [row] }; } });
  const detailResult = await service.get({ role: "user" }, "Hunter's Mark");
  assert.equal(detailResult.title, "Метка охотника");
  assert.equal(detailResult.sourceVersion?.rawBlobPath, detail.blobPath);
  assert.equal(detailResult.citations.length, 11);
  assert.equal(detailResult.citations[0].previewUrl, null);
  assert.equal(detailResult.citations[0].sourceUrl, detail.sourceUrl);
  assert.equal(detailResult.citations[0].sourceDetailUrl, `/api/sources/${synced.source_id}`);
  assert.match(detailSql, /compendium_normalize_name\(alias\).*compendium_normalize_name/s);
});

test("PDF rows expose previews while external rows expose source links", async () => {
  const row = spellRow();
  const service = new SpellReadService({ async query() { return { rows: [row] }; } });
  const detailResult = await service.get({ role: "user" }, row.entry_id);
  assert.equal(detailResult.title, "Метка охотника");
  assert.deepEqual(detailResult.aliases, ["Hunter's Mark"]);
  assert.equal(detailResult.sourceVersions.length, 2);
  assert.equal(detailResult.citations[0].previewUrl, `/api/citations/preview?sourceId=${sourceUuid}&fileId=${fileUuid}&page=42`);

  const listUi = await readFile("src/app/spells/spell-list.tsx", "utf8");
  const detailUi = await readFile("src/app/spells/[identifier]/spell-detail.tsx", "utf8");
  for (const field of ["casting", "range", "duration", "component", "ritual", "concentration", "class"]) {
    assert.match(listUi, new RegExp(`name=\\"${field}\\"`));
  }
  assert.match(detailUi, /citation\.previewUrl \?/);
  assert.match(detailUi, /spell\.sourceVersions/);

  const snapshotRow = { ...row, mime_type: "text/html", canonical_payload: {
    sourceVersion: { url: detail.sourceUrl, fingerprintSha256: detail.sha256, rawBlobPath: detail.blobPath,
      fetchedAt: detail.fetchedAt, fileChecksumSha256: "d".repeat(64) },
    citations: [{ citationId: "spell-body", page: null, quote: "Mark one creature", section: "Spells",
      fieldPath: "$.body", sourceUrl: detail.sourceUrl }],
  } };
  const snapshot = await new SpellReadService({ async query() { return { rows: [snapshotRow] }; } }).get({ role: "user" }, row.entry_id);
  assert.equal(snapshot.citations[0].previewUrl, null);
  assert.equal(snapshot.citations[0].sourceUrl, detail.sourceUrl);
});

test("spell pages retain RU/EN, mobile, and print contracts", async () => {
  const [i18n, css, list, detailPage] = await Promise.all([
    readFile("src/components/ui/i18n.tsx", "utf8"),
    readFile("src/app/globals.css", "utf8"),
    readFile("src/app/spells/spell-list.tsx", "utf8"),
    readFile("src/app/spells/[identifier]/spell-detail.tsx", "utf8"),
  ]);
  assert.match(i18n, /ru: \{[\s\S]*spellCatalog: "Каталог заклинаний"/);
  assert.match(i18n, /en: \{[\s\S]*spellCatalog: "Spell catalog"/);
  assert.match(css, /@media \(max-width: 39\.999rem\)[\s\S]*\.spell-filters,[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /@media print[\s\S]*\.app-content form,[\s\S]*display: none !important/);
  assert.match(css, /@media print[\s\S]*\.spell-detail section,[\s\S]*break-inside: avoid/);
  assert.match(list, /<select name="ritual"[\s\S]*value=""[\s\S]*value="true"[\s\S]*value="false"/);
  assert.match(list, /<select name="concentration"/);
  assert.match(detailPage, /Прорицание.*Divination/);
  assert.match(detailPage, /Следопыт.*Ranger/);
});

function spellRow() {
  const typed = [
    ["level", "number", 1], ["school", "string", "divination"], ["ritual", "boolean", false],
    ["concentration", "boolean", true], ["casting-time", "string", "1 bonus action"],
    ["range", "string", "90 feet"], ["duration", "string", "Concentration, up to 1 hour"],
    ["components", "string", "V"], ["classes", "stringList", ["class:17"]],
  ].map(([key, type, value]) => ({ key, label: key, type, value }));
  return {
    entry_id: "spell-spells-10195", revision_id: `rev-${"b".repeat(64)}`, name: "Метка охотника",
    aliases: ["Hunter's Mark"], typed_fields: typed, plain_text: "Mark one creature you can see.",
    canonical_payload: { citations: [{ citationId: "spell-body", page: 42, quote: "Mark one creature", section: "Spells" }] },
    source_id: sourceUuid, file_id: fileUuid, mime_type: "application/pdf", source_title: "Player's Handbook",
    edition: "5.5e", language: "ru", publication_code: "PHB", publication_revision: "2024",
    source_priority: 100, sort_title: "метка охотника",
    source_versions: [
      { sourceId: sourceUuid, title: "Player's Handbook", code: "PHB", revision: "2024", revisionId: `rev-${"b".repeat(64)}` },
      { sourceId: "44444444-4444-4444-8444-444444444444", title: "Rules update", code: "RU", revision: "1", revisionId: `rev-${"c".repeat(64)}` },
    ],
  };
}
