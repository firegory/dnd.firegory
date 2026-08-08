import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractCandidates } from "../../src/server/compendium/candidate-extraction.ts";
import { projectExtractedCandidate, projectSnapshotSpellCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { CompendiumImportReviewService } from "../../src/server/compendium/import-review.ts";
import { creatureCandidate, nextDndImportBatch } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import { nextDndCardFingerprint } from "../../src/server/compendium/next-dnd/parser.ts";
import { ancientDragonDetail } from "../fixtures/next-dnd/bestiary.mts";

const runId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const admin = { userId: "44444444-4444-4444-8444-444444444444", role: "admin" } as const;
const activeRevision = `rev-${"b".repeat(64)}`;
const secondCandidateId = "66666666-6666-4666-8666-666666666666";
const generationId = "77777777-7777-4777-8777-777777777777";
const chunkId = "88888888-8888-4888-8888-888888888888";
const secondChunkId = "99999999-9999-4999-8999-999999999999";
const astralChunkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const occurrenceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const previousCandidateId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const currentGenerationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const previousCreatedAt = "2026-08-05T00:00:00.000Z";
const boundary = {
  sourceId: firstSourceId(), fileId, generationId, edition: "5e", language: "en", accessTier: "open", shared: false, ownerUserId: null,
} as const;
const fixtureText = (await readFile("tests/fixtures/candidate-extraction/en-spell.txt", "utf8")).trim();
const astralFixtureText = (await readFile("tests/fixtures/candidate-extraction/en-astral-spell.txt", "utf8")).trim();
const spellShieldText = "Shield\n1st-level abjuration\nCasting Time: 1 reaction\nRange: Self\nComponents: V, S\nDuration: 1 round\nAn invisible barrier of magical force appears and protects you.";
const equipmentShieldText = "Armor\n| Name | Cost | Weight |\n| --- | --- | --- |\n| Shield | 10 gp | 6 lb. |";
const unsupportedEquipmentText = "Armor\n| Name | Cost | Weight |\n| --- | --- | --- |\n| Mystery Shield | — | — |";

async function extracted(text: string, id = chunkId) {
  const result = await extractCandidates({
    boundary,
    chunks: [{ id, chunkIndex: id === chunkId ? 0 : 1, pageNumber: 1, sectionHeading: null, quoteText: text }],
    existingCandidates: [],
  }, { modelVersion: "none" });
  assert.equal(result.candidates.length, 1);
  return result.candidates[0];
}

const content = await extracted(fixtureText);
const spellShield = await extracted(spellShieldText);
const equipmentShield = await extracted(equipmentShieldText, secondChunkId);
const unsupportedEquipment = await extracted(unsupportedEquipmentText, secondChunkId);
const astralSpell = await extracted(astralFixtureText, astralChunkId);
const collectorContent = nextDndImportBatch({
  status: "complete", robots: {}, parserFailures: [],
  categories: [{ index: {}, entryCount: 1, details: [{
    category: "spells", externalId: "10195", sourceUrl: "https://next.dnd.su/spells/10195-hunters-mark",
    sha256: "f".repeat(64), parserVersion: "next-dnd-2024-v3", fetchedAt: "2026-08-06T12:00:00.000Z",
    blobPath: `blobs/${"f".repeat(64)}.html`,
    normalized: { title: "Метка охотника", contentHtml: "<article>Rules</article>", contentText: "Casting Time: 1 bonus action. Range: 90 feet. Components: V. Duration: Concentration, up to 1 hour. Mark one creature you can see." },
    indexMetadata: { level: 1, school: "Прорицание", title_en: "Hunter's Mark", filter_class: [17], item_tags: { concentration: true } },
    indexSource: { url: "https://next.dnd.su/spells/", fingerprintSha256: "c".repeat(64),
      rawBlobPath: `blobs/${"c".repeat(64)}.html`, fetchedAt: "2026-08-06T11:59:00.000Z",
      cardFingerprintSha256: nextDndCardFingerprint({ level: 1, school: "Прорицание", title_en: "Hunter's Mark",
        filter_class: [17], item_tags: { concentration: true } }) },
  }] }],
} as never).candidates[0].content;
const creatureDetail = ancientDragonDetail();
const creatureCollectorContent = creatureCandidate(creatureDetail as never);

function chunkFields(text = fixtureText, id = chunkId) {
  return { chunk_id: id, chunk_index: id === chunkId ? 0 : 1, page_number: 1, section_heading: null, quote_text: text };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return { id: candidateId, import_run_id: runId, occurrence_id: occurrenceId, previous_candidate_id: null,
    source_id: firstSourceId(), file_id: fileId, generation_id: generationId,
    edition: "5e", language: "en", access_tier: "open", shared: false, owner_user_id: null,
    candidate_key: content.candidateKey, entry_type: content.entryType, diff_status: "new", content,
    content_sha256: "e".repeat(64),
    previous_content: null, invalid_reason: null, locator: "page:1", ...chunkFields(),
    occurrence_fingerprint_sha256: "f".repeat(64), occurrence_raw_blob_path: `blobs/${"f".repeat(64)}.html`,
    occurrence_source_fetched_at: "2026-08-06T12:00:00.000Z", file_checksum_sha256: "a".repeat(64),
    occurrence_index_locator: collectorIndexEvidence().url,
    occurrence_index_fingerprint_sha256: collectorIndexEvidence().sha256,
    occurrence_raw_index_blob_path: collectorIndexEvidence().rawBlobPath,
    occurrence_index_source_fetched_at: collectorIndexEvidence().fetchedAt,
    occurrence_index_card_fingerprint_sha256: collectorIndexEvidence().cardFingerprintSha256,
    occurrence_metadata_evidence_text: collectorIndexEvidence().metadataEvidenceText,
    previous_fingerprint_sha256: "f".repeat(64), previous_raw_blob_path: `blobs/${"f".repeat(64)}.html`,
    previous_source_fetched_at: "2026-08-06T12:00:00.000Z",
    previous_index_locator: collectorIndexEvidence().url, previous_index_fingerprint_sha256: collectorIndexEvidence().sha256,
    previous_raw_index_blob_path: collectorIndexEvidence().rawBlobPath, previous_index_source_fetched_at: collectorIndexEvidence().fetchedAt,
    previous_index_card_fingerprint_sha256: collectorIndexEvidence().cardFingerprintSha256,
    previous_metadata_evidence_text: collectorIndexEvidence().metadataEvidenceText,
    created_at: "2026-08-06T00:00:00.000Z", run_status: "succeeded", decision: null, resolved_content: null,
    publication_status: null, publication_attempt: null, idempotency_key: null, last_error: null, reviewed_by: null, reviewed_at: null,
    expected_active_revision_id: null, expected_active_revision_captured: false,
    ...overrides };
}

function collectorIndexEvidence() {
  const index = (collectorContent.sourceVersion as { index: Record<string, string> }).index;
  return index as { url: string; sha256: string; rawBlobPath: string; fetchedAt: string; cardFingerprintSha256: string; metadataEvidenceText: string };
}

function missingCandidate(overrides: Record<string, unknown> = {}) {
  return candidate({
    occurrence_id: null, previous_candidate_id: previousCandidateId, generation_id: currentGenerationId,
    candidate_key: "shield", entry_type: "equipment", diff_status: "missing", content: equipmentShield,
    content_sha256: "d".repeat(64), previous_content: equipmentShield, previous_content_sha256: "d".repeat(64),
    locator: null, chunk_id: null, chunk_index: null, page_number: null, section_heading: null, quote_text: null,
    previous_source_id: firstSourceId(), previous_file_id: fileId, previous_generation_id: generationId,
    previous_candidate_key: "shield", previous_entry_type: "equipment", previous_created_at: previousCreatedAt,
    previous_occurrence_id: occurrenceId, previous_locator: "page:1", previous_chunk_id: secondChunkId,
    previous_page_number: 1, previous_chunk_index: 1, previous_section_heading: null, previous_quote_text: equipmentShieldText,
    previous_decision: "approved", previous_resolved_content: null, previous_publication_status: "completed",
    ...overrides,
  });
}

function collectorCandidate(overrides: Record<string, unknown> = {}) {
  return candidate({
    candidate_key: "spells-10195", entry_type: "spell", content: collectorContent,
    generation_id: null, locator: "https://next.dnd.su/spells/10195-hunters-mark",
    chunk_id: null, chunk_index: null, page_number: null, section_heading: null, quote_text: null,
    ...overrides,
  });
}

function source() {
  return { canonical_source_id: "players-handbook", title: "Player's Handbook", category: "core_rules", edition: "5e", language: "en",
    access_tier: "open", shared: false, owner_user_id: null, publication_code: "PHB", publication_title: "Player's Handbook",
    publisher: "Wizards", release_year: 2014, publication_revision: null, external_origin_url: null, external_origin_id: null,
    attribution: null, source_priority: 100, canonical_book_id: "players-handbook", license: null,
    canonical_files: [{ fileId, path: `sources/players-handbook/files/${fileId}.pdf`, mediaType: "application/pdf", contentHash: `sha256:${"a".repeat(64)}` }] };
}

function canonicalSource() {
  return {
    schemaVersion: 1, kind: "source", sourceId: "players-handbook", title: "Player's Handbook", category: "core_rules",
    edition: "5e", language: "en", accessTier: "open", shared: false, ownerUserId: null,
    publication: { code: "PHB", title: "Player's Handbook", publisher: "Wizards", releaseYear: 2014, sourcePriority: 100, canonicalBookId: "players-handbook" },
    files: [{ fileId, path: `sources/players-handbook/files/${fileId}.pdf`, mediaType: "application/pdf", contentHash: `sha256:${"a".repeat(64)}` }],
  } as const;
}

const previousEquipmentRevision = projectExtractedCandidate(equipmentShield, {
  candidateKey: "shield", entryType: "equipment", createdAt: previousCreatedAt, boundary,
  source: canonicalSource(),
  chunk: { id: secondChunkId, chunkIndex: 1, pageNumber: 1, sectionHeading: null, quoteText: equipmentShieldText },
}).revisionId;
const previousCollectorRevision = projectSnapshotSpellCandidate(collectorContent, {
  candidateKey: "spells-10195", createdAt: previousCreatedAt, source: canonicalSource(), fileId,
  evidence: {
    sourceUrl: "https://next.dnd.su/spells/10195-hunters-mark", fingerprintSha256: "f".repeat(64),
    rawBlobPath: `blobs/${"f".repeat(64)}.html`, fetchedAt: "2026-08-06T12:00:00.000Z",
    fileChecksumSha256: "a".repeat(64),
    indexUrl: collectorIndexEvidence().url, indexFingerprintSha256: collectorIndexEvidence().sha256,
    rawIndexBlobPath: collectorIndexEvidence().rawBlobPath, indexFetchedAt: collectorIndexEvidence().fetchedAt,
    indexCardFingerprintSha256: collectorIndexEvidence().cardFingerprintSha256,
    metadataEvidenceText: collectorIndexEvidence().metadataEvidenceText,
  },
}).revisionId;

test("approval persists audit intent and submits only a worker publication command", async () => {
  const statements: string[] = [];
  let submitted: unknown;
  const db = { async query(sql: string) {
    statements.push(sql);
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [candidate()] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => { submitted = input; return { commandPath: "/spool/command", existing: false }; },
    unpublish: async () => { throw new Error("unexpected unpublish"); },
  }, async () => { throw new Error("mutation must not recapture canonical state"); });
  const result = await service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null } });
  assert.equal(result[0].publicationStatus, "queued");
  const revision = (submitted as { revision: { entryId: string; entry: { typedFields: unknown[] }; citations: Array<Record<string, unknown>> } }).revision;
  assert.equal(revision.entryId, "spell-burning-hands");
  assert.equal(revision.entry.typedFields.length, Object.keys(content.attributes).length);
  assert.equal(revision.citations.length, content.citations.length);
  assert.equal(revision.citations.every(({ fileId: citationFile, section }) => citationFile === fileId && String(section).includes(chunkId)), true);
  assert.equal(revision.citations.some(({ citationId }) => citationId === "evidence-attribute-casting-time-1"), true);
  assert.equal((submitted as { expectedActiveRevisionId: string | null }).expectedActiveRevisionId, null, "explicit absence is captured");
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_import_candidate_reviews")));
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO compendium_import_review_audit")));
  assert.ok(statements.some((sql) => sql.includes("publication_status = 'pending'")), "queued marker cannot overwrite worker terminal state");
  assert.equal(statements.some((sql) => /(?:INSERT|UPDATE)\s+(?:INTO\s+)?compendium_(?:versions|revisions)/i.test(sql)), false);
});

test("invalid candidates cannot bypass merge safeguards", async () => {
  const db = { async query(sql: string, values: readonly unknown[] = []) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [candidate({ diff_status: "invalid", invalid_reason: "bad extraction" })] };
    void values;
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("queue unavailable"); }, unpublish: async () => { throw new Error("queue unavailable"); },
  }, async () => new Map());
  await assert.rejects(service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null } }), /cannot be approved without a merge/);
  const result = await service.act(admin, runId, { candidateIds: [candidateId], action: "unpublish", activeRevisionTokens: { [candidateId]: null } }).catch((error) => error);
  assert.match(result.message, /Only missing candidates/);
});

test("publication submission exceptions remain pending and retryable", async () => {
  const updates: unknown[][] = [];
  const db = { async query(sql: string, values: readonly unknown[] = []) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [candidate()] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    if (sql.startsWith("UPDATE compendium_import_candidate_reviews")) updates.push([...values]);
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("queue unavailable"); }, unpublish: async () => { throw new Error("queue unavailable"); },
  }, async () => new Map());
  const result = await service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null } });
  assert.equal(result[0].publicationStatus, "pending");
  assert.equal(result[0].error, "queue unavailable");
  assert.equal(updates.length, 0, "submission exceptions leave the same pending attempt untouched");
});

test("loading a run never reconciles outcomes or writes audit actors", async () => {
  const statements: string[] = [];
  const db = { async query(sql: string) {
    statements.push(sql);
    if (sql.includes("FROM compendium_import_runs run JOIN sources")) return { rows: [{
      id: runId, source_id: firstSourceId(), source_title: "Source", file_id: fileId, status: "succeeded",
      created_at: "2026-08-06T00:00:00Z", finished_at: "2026-08-06T00:01:00Z", candidate_count: 0,
      new_count: 0, unchanged_count: 0, changed_count: 0, missing_count: 0, duplicate_count: 0,
      invalid_count: 0, diagnostic_count: 0, pending_review_count: 0, failed_publication_count: 0,
    }] };
    return { rows: [] };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); }, unpublish: async () => { throw new Error("unused"); },
  }, async () => new Map());
  await service.getRun(admin, runId);
  assert.equal(statements.every((sql) => /^SELECT\b/.test(sql.trim())), true);
});

function firstSourceId() { return "55555555-5555-4555-8555-555555555555"; }

test("a stale page token is returned, persisted, and submitted without click-time recapture", async () => {
  let canonicalToken = activeRevision;
  let reads = 0;
  let submittedToken: string | null | undefined;
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_runs run JOIN sources")) return { rows: [{
      id: runId, source_id: firstSourceId(), source_title: "Source", file_id: fileId, status: "succeeded",
      created_at: "2026-08-06T00:00:00Z", finished_at: "2026-08-06T00:01:00Z", candidate_count: 1,
      new_count: 1, unchanged_count: 0, changed_count: 0, missing_count: 0, duplicate_count: 0,
      invalid_count: 0, diagnostic_count: 0, pending_review_count: 1, failed_publication_count: 0,
    }] };
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [candidate()] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => { submittedToken = input.expectedActiveRevisionId; return { commandPath: "/spool/command", existing: false }; },
    unpublish: async () => { throw new Error("unused"); },
  }, async (entryIds) => {
    reads++;
    assert.deepEqual(entryIds, ["spell-burning-hands"]);
    return new Map(entryIds.map((entryId) => [entryId, canonicalToken]));
  });
  const displayed = await service.getRun(admin, runId);
  assert.equal(displayed.candidates[0].entryId, "spell-burning-hands");
  assert.equal(displayed.candidates[0].activeRevisionToken, activeRevision);
  canonicalToken = `rev-${"c".repeat(64)}`;
  await service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: displayed.candidates[0].activeRevisionToken } });
  assert.equal(submittedToken, activeRevision);
  assert.equal(reads, 1, "canonical state is read for display only");
});

test("submission crash stays pending and retry reuses the same idempotency key and token", async () => {
  let review: Record<string, unknown> = {};
  const submitted: Array<{ key: string; token: string | null }> = [];
  let submission = 0;
  const db = { async query(sql: string, values: readonly unknown[] = []) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [candidate(review)] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    if (sql.includes("INSERT INTO compendium_import_candidate_reviews")) {
      review = {
        decision: values[2], resolved_content: null, publication_status: values[4], publication_attempt: values[5],
        idempotency_key: values[6], expected_active_revision_id: values[7], expected_active_revision_captured: values[8],
        reviewed_by: admin.userId, reviewed_at: "2026-08-06T00:02:00Z",
      };
    }
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => {
      submitted.push({ key: input.idempotencyKey, token: input.expectedActiveRevisionId });
      if (submission++ === 0) throw new Error("crash after enqueue");
      return { commandPath: "/spool/command", existing: true };
    },
    unpublish: async () => { throw new Error("unused"); },
  }, async () => { throw new Error("mutation must not read canonical state"); });
  const tokens = { [candidateId]: activeRevision };
  const first = await service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: tokens });
  assert.equal(first[0].publicationStatus, "pending");
  const retried = await service.act(admin, runId, { candidateIds: [candidateId], action: "retry", activeRevisionTokens: tokens });
  assert.equal(retried[0].publicationStatus, "queued");
  assert.deepEqual(submitted, [submitted[0], submitted[0]]);
  assert.equal(review.publication_attempt, 1);
});

test("only a worker-terminal failure permits a new attempt with the newly displayed token", async () => {
  const nextToken = `rev-${"d".repeat(64)}`;
  let persisted: readonly unknown[] = [];
  let submitted: { key: string; token: string | null } | null = null;
  const failed = candidate({
    decision: "approved", publication_status: "failed", publication_attempt: 1,
    idempotency_key: "review-old-attempt", expected_active_revision_id: activeRevision,
    expected_active_revision_captured: true, last_error: "stale command", reviewed_by: admin.userId,
    reviewed_at: "2026-08-06T00:02:00Z",
  });
  const db = { async query(sql: string, values: readonly unknown[] = []) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [failed] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    if (sql.includes("INSERT INTO compendium_import_candidate_reviews")) persisted = values;
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => { submitted = { key: input.idempotencyKey, token: input.expectedActiveRevisionId }; return { commandPath: "/spool/new", existing: false }; },
    unpublish: async () => { throw new Error("unused"); },
  }, async () => { throw new Error("mutation must not read canonical state"); });
  await service.act(admin, runId, { candidateIds: [candidateId], action: "retry", activeRevisionTokens: { [candidateId]: nextToken } });
  assert.equal(persisted[5], 2);
  assert.notEqual(persisted[6], "review-old-attempt");
  assert.equal(persisted[7], nextToken);
  assert.equal(submitted?.token, nextToken);
});

test("bulk publication submits each candidate's displayed token", async () => {
  const secondToken = `rev-${"e".repeat(64)}`;
  const submitted = new Map<string, string | null>();
  const candidates = [
    candidate({ content: spellShield, candidate_key: "shield", ...chunkFields(spellShieldText) }),
    candidate({ id: secondCandidateId, content: equipmentShield, entry_type: "equipment", candidate_key: "shield", ...chunkFields(equipmentShieldText, secondChunkId) }),
  ];
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: candidates };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => {
      submitted.set(input.revision.entryId, input.expectedActiveRevisionId);
      return { commandPath: `/spool/${input.revision.entryId}`, existing: false };
    },
    unpublish: async () => { throw new Error("unused"); },
  }, async () => { throw new Error("mutation must not read canonical state"); });
  await service.act(admin, runId, {
    candidateIds: [candidateId, secondCandidateId], action: "approve",
    activeRevisionTokens: { [candidateId]: null, [secondCandidateId]: secondToken },
  });
  assert.deepEqual(Object.fromEntries(submitted), { "spell-shield": null, "equipment-shield": secondToken });
});

test("typed candidates receive independent canonical CAS lookups", async () => {
  const candidates = [
    candidate({ content: spellShield, candidate_key: "shield", ...chunkFields(spellShieldText) }),
    candidate({ id: secondCandidateId, content: equipmentShield, entry_type: "equipment", candidate_key: "shield", ...chunkFields(equipmentShieldText, secondChunkId) }),
  ];
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_runs run JOIN sources")) return { rows: [{
      id: runId, source_id: firstSourceId(), source_title: "Source", file_id: fileId, status: "succeeded",
      created_at: "2026-08-06T00:00:00Z", finished_at: "2026-08-06T00:01:00Z", candidate_count: 2,
      new_count: 2, unchanged_count: 0, changed_count: 0, missing_count: 0, duplicate_count: 0,
      invalid_count: 0, diagnostic_count: 0, pending_review_count: 2, failed_publication_count: 0,
    }] };
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: candidates };
    return { rows: [] };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); }, unpublish: async () => { throw new Error("unused"); },
  }, async (entryIds) => {
    assert.deepEqual(new Set(entryIds), new Set(["spell-shield", "equipment-shield"]));
    return new Map([["spell-shield", activeRevision], ["equipment-shield", null]]);
  });
  const displayed = await service.getRun(admin, runId);
  assert.deepEqual(displayed.candidates.map(({ entryId, activeRevisionToken }) => [entryId, activeRevisionToken]), [
    ["spell-shield", activeRevision], ["equipment-shield", null],
  ]);
});

test("unsupported extracted attribute projection is rejected before review or queue", async () => {
  let submitted = false;
  const row = candidate({
    content: unsupportedEquipment, entry_type: "equipment", candidate_key: unsupportedEquipment.candidateKey,
    ...chunkFields(unsupportedEquipmentText, secondChunkId),
  });
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { submitted = true; throw new Error("must not submit"); },
    unpublish: async () => { throw new Error("unused"); },
  }, async () => new Map());
  await assert.rejects(
    service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null } }),
    /cannot be represented without changing its evidence semantics/,
  );
  assert.equal(submitted, false);
});

test("projection converts #77 code-point evidence into exact canonical citation offsets", async () => {
  let revision: { text: { plain: string }; citations: Array<{ quote: string; startOffset: number; endOffset: number }> } | null = null;
  const row = candidate({
    content: astralSpell, candidate_key: astralSpell.candidateKey,
    ...chunkFields(astralFixtureText, astralChunkId),
  });
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => { revision = input.revision; return { commandPath: "/spool/astral", existing: false }; },
    unpublish: async () => { throw new Error("unused"); },
  }, async () => new Map());
  await service.act(admin, runId, { candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null } });
  assert.ok(revision);
  for (const citation of revision.citations) {
    assert.equal(revision.text.plain.slice(citation.startOffset, citation.endOffset), citation.quote);
  }
});

test("unpublication uses the same type-qualified identity as projection and CAS lookup", async () => {
  let target: string | null = null;
  const row = missingCandidate();
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); },
    unpublish: async (input) => { target = input.entryId; return { commandPath: "/spool/unpublish", existing: false }; },
  }, async () => { throw new Error("mutation must not read canonical state"); });
  await service.act(admin, runId, { candidateIds: [candidateId], action: "unpublish", activeRevisionTokens: { [candidateId]: previousEquipmentRevision } });
  assert.equal(target, "equipment-shield");
});

test("missing review derives unpublication target, CAS, and evidence from the previous extraction", async () => {
  let activeToken = previousEquipmentRevision;
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_runs run JOIN sources")) return { rows: [{
      id: runId, source_id: firstSourceId(), source_title: "Book", file_id: fileId, status: "succeeded",
      created_at: "2026-08-06T00:00:00Z", finished_at: "2026-08-06T00:01:00Z", candidate_count: 1,
      new_count: 0, unchanged_count: 0, changed_count: 0, missing_count: 1, duplicate_count: 0,
      invalid_count: 0, diagnostic_count: 0, pending_review_count: 1, failed_publication_count: 0,
    }] };
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [missingCandidate()] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [] };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); }, unpublish: async () => { throw new Error("unused"); },
  }, async (entryIds) => {
    assert.deepEqual(entryIds, ["equipment-shield"]);
    return new Map([["equipment-shield", activeToken]]);
  });
  const review = (await service.getRun(admin, runId)).candidates[0];
  assert.deepEqual({
    capability: review.publicationCapability, entryId: review.entryId, token: review.activeRevisionToken,
    sourceId: review.evidenceSourceId, fileId: review.evidenceFileId, generationId: review.evidenceGenerationId,
    chunkId: review.chunkId, page: review.page, locator: review.locator,
  }, {
    capability: "can_unpublish", entryId: "equipment-shield", token: previousEquipmentRevision,
    sourceId: firstSourceId(), fileId, generationId, chunkId: secondChunkId, page: 1, locator: "page:1",
  });
  activeToken = activeRevision;
  const stale = (await service.getRun(admin, runId)).candidates[0];
  assert.equal(stale.publicationCapability, "requires_extraction");
  assert.match(stale.publicationBlockReason!, /not the active canonical CAS target/);
});

test("missing extraction candidates can still be rejected without publication", async () => {
  const mutations: string[] = [];
  let submitted = false;
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [missingCandidate()] };
    if (/^(?:INSERT|UPDATE)/.test(sql.trim())) mutations.push(sql);
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { submitted = true; throw new Error("unused"); },
    unpublish: async () => { submitted = true; throw new Error("unused"); },
  }, async () => new Map());
  const result = await service.act(admin, runId, { candidateIds: [candidateId], action: "reject" });
  assert.equal(result[0].publicationStatus, "idle");
  assert.equal(mutations.some((sql) => sql.includes("compendium_import_candidate_reviews")), true);
  assert.equal(submitted, false);
});

test("missing candidates reject cross-source, file, type, key, and CAS tampering before mutation", async () => {
  const mutations: string[] = [];
  let row = missingCandidate();
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    if (/^(?:INSERT|UPDATE)/.test(sql.trim())) mutations.push(sql);
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); }, unpublish: async () => { throw new Error("must not queue"); },
  }, async () => new Map());
  for (const action of ["approve", "merge"] as const) {
    await assert.rejects(service.act(admin, runId, {
      candidateIds: [candidateId], action, activeRevisionTokens: { [candidateId]: previousEquipmentRevision },
      ...(action === "merge" ? { resolvedContent: equipmentShield } : {}),
    }), /missing candidates cannot (?:be approved|be merged)/i);
  }
  for (const tamper of [
    { previous_source_id: secondCandidateId },
    { previous_file_id: secondCandidateId },
    { previous_entry_type: "spell" },
    { previous_candidate_key: "other-shield" },
  ]) {
    row = missingCandidate(tamper);
    await assert.rejects(service.act(admin, runId, {
      candidateIds: [candidateId], action: "unpublish", activeRevisionTokens: { [candidateId]: previousEquipmentRevision },
    }), /source, file, type, and key must match/);
  }
  row = missingCandidate();
  await assert.rejects(service.act(admin, runId, {
    candidateIds: [candidateId], action: "unpublish", activeRevisionTokens: { [candidateId]: activeRevision },
  }), /not the displayed canonical CAS target/);
  assert.deepEqual(mutations, []);
});

test("missing previously published collector spells can unpublish through validated evidence and CAS", async () => {
  const row = missingCandidate({
    candidate_key: "spells-10195", entry_type: "spell", content: collectorContent, content_sha256: "f".repeat(64),
    previous_content: collectorContent, previous_content_sha256: "f".repeat(64),
    previous_candidate_key: "spells-10195", previous_entry_type: "spell", previous_generation_id: null,
    previous_occurrence_id: occurrenceId, previous_locator: "https://next.dnd.su/spells/10195-hunters-mark",
    previous_chunk_id: null, previous_chunk_index: null, previous_page_number: null, previous_quote_text: null,
  });
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); }, unpublish: async (input) => {
      assert.equal(input.expectedActiveRevisionId, previousCollectorRevision);
      return { commandPath: "/spool/unpublish-collector", existing: false };
    },
  }, async () => new Map());
  const result = await service.act(admin, runId, {
    candidateIds: [candidateId], action: "unpublish", activeRevisionTokens: { [candidateId]: previousCollectorRevision },
  });
  assert.equal(result[0].publicationStatus, "queued");
});

test("review exposes a complete typed snapshot spell for explicit approval", async () => {
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_runs run JOIN sources")) return { rows: [{
      id: runId, source_id: firstSourceId(), source_title: "Snapshot", file_id: fileId, status: "succeeded",
      created_at: "2026-08-06T00:00:00Z", finished_at: "2026-08-06T00:01:00Z", candidate_count: 1,
      new_count: 1, unchanged_count: 0, changed_count: 0, missing_count: 0, duplicate_count: 0,
      invalid_count: 0, diagnostic_count: 0, pending_review_count: 1, failed_publication_count: 0,
    }] };
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [collectorCandidate()] };
    return { rows: [] };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { throw new Error("unused"); }, unpublish: async () => { throw new Error("unused"); },
  }, async (entryIds) => { assert.deepEqual(entryIds, ["spell-spells-10195"]); return new Map(); });
  const result = await service.getRun(admin, runId);
  assert.deepEqual({
    origin: result.candidates[0].payloadOrigin,
    capability: result.candidates[0].publicationCapability,
    entryId: result.candidates[0].entryId,
    token: result.candidates[0].activeRevisionToken,
  }, { origin: "collector_snapshot", capability: "publishable", entryId: "spell-spells-10195", token: null });
  assert.equal(result.candidates[0].publicationBlockReason, null);
});

test("typed snapshot publication still requires an audited review action", async () => {
  const writes: string[] = [];
  let submitted: { entryId: string; citations: readonly unknown[] } | null = null;
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    if (/^(?:INSERT|UPDATE)/.test(sql.trim())) writes.push(sql);
    return { rows: [], rowCount: 1 };
  } };
  const rows = [collectorCandidate()];
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async (input) => {
      submitted = { entryId: input.revision.entryId, citations: input.revision.citations };
      return { commandPath: "/spool/snapshot-spell", existing: false };
    },
    unpublish: async () => { throw new Error("must not unpublish"); },
  }, async () => new Map());
  assert.equal(submitted, null, "classification and review display never publish");
  const approved = await service.act(admin, runId, {
    candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null },
  });
  assert.equal(approved[0].publicationStatus, "queued");
  assert.equal(submitted?.entryId, "spell-spells-10195");
  assert.equal(submitted?.citations.length, 11);
  assert.equal(writes.some((sql) => sql.includes("compendium_import_candidate_reviews")), true);
});

test("merge repairs only typed collector fields while immutable evidence stays locked", async () => {
  const incomplete = structuredClone(collectorContent) as Record<string, unknown> & {
    attributes: Record<string, unknown>;
    extraction: Record<string, unknown>;
    citations: Array<Record<string, unknown>>;
  };
  incomplete.attributes.castingTime = null;
  incomplete.extraction = { status: "needs_review", missingFields: ["castingTime"] };
  incomplete.citations = incomplete.citations.filter((citation) => citation.fieldPath !== "$.attributes.castingTime");
  const row = collectorCandidate({ content: incomplete });
  let published = false;
  const db = { async query(sql: string) {
    if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
    if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
    return { rows: [], rowCount: 1 };
  } };
  const service = new CompendiumImportReviewService(async (callback) => callback(db), {
    publish: async () => { published = true; return { commandPath: "/spool/repaired", existing: false }; },
    unpublish: async () => { throw new Error("unused"); },
  }, async () => new Map());
  await assert.rejects(service.act(admin, runId, {
    candidateIds: [candidateId], action: "approve", activeRevisionTokens: { [candidateId]: null },
  }), /not publishable.*incomplete/i);
  const merged = await service.act(admin, runId, {
    candidateIds: [candidateId], action: "merge", activeRevisionTokens: { [candidateId]: null },
    resolvedContent: collectorContent,
  });
  assert.equal(merged[0].publicationStatus, "queued");
  assert.equal(published, true);

  const unsupported = structuredClone(collectorContent) as Record<string, unknown> & {
    attributes: Record<string, unknown>;
    citations: Array<Record<string, unknown>>;
  };
  unsupported.attributes.range = "Mark one creature you can see.";
  unsupported.citations = unsupported.citations.map((citation) => citation.fieldPath === "$.attributes.range"
    ? { ...citation, quote: "Mark one creature you can see." } : citation);
  const rejectingService = new CompendiumImportReviewService(async (callback) => callback({
    async query(sql: string) {
      if (sql.includes("FROM compendium_import_candidates candidate")) return { rows: [row] };
      if (sql.includes("FROM sources source LEFT JOIN files")) return { rows: [source()] };
      return { rows: [], rowCount: 1 };
    },
  }), { publish: async () => { throw new Error("must not publish"); }, unpublish: async () => { throw new Error("unused"); } }, async () => new Map());
  await assert.rejects(rejectingService.act(admin, runId, {
    candidateIds: [candidateId], action: "merge", activeRevisionTokens: { [candidateId]: null }, resolvedContent: unsupported,
  }), /range citation is not its exact detail value/);

  const tampered = structuredClone(collectorContent) as Record<string, unknown> & { sourceVersion: Record<string, unknown> };
  tampered.sourceVersion.url = "https://next.dnd.su/spells/99999-tampered";
  const idleService = new CompendiumImportReviewService(async (callback) => callback({
    async query(sql: string) { return { rows: sql.includes("FROM compendium_import_candidates candidate") ? [row] : [], rowCount: 1 }; },
  }), { publish: async () => { throw new Error("must not publish"); }, unpublish: async () => { throw new Error("unused"); } }, async () => new Map());
  await assert.rejects(idleService.act(admin, runId, {
    candidateIds: [candidateId], action: "merge", activeRevisionTokens: { [candidateId]: null }, resolvedContent: tampered,
  }), /cannot modify immutable sourceVersion evidence/);
});

test("resolved snapshot creature merges are reclassified against immutable evidence", async () => {
  const invalid = structuredClone(creatureCollectorContent) as typeof creatureCollectorContent & {attributes:{armorClass:Array<{value:number}>}};
  invalid.attributes.armorClass[0].value = 23;
  const index = creatureDetail.indexSource;
  const row = collectorCandidate({
    candidate_key:"bestiary-999",entry_type:"creature",content:invalid,
    locator:creatureDetail.sourceUrl,occurrence_fingerprint_sha256:creatureDetail.sha256,
    occurrence_raw_blob_path:creatureDetail.blobPath,occurrence_source_fetched_at:creatureDetail.fetchedAt,
    occurrence_index_locator:index.url,occurrence_index_fingerprint_sha256:index.fingerprintSha256,
    occurrence_raw_index_blob_path:index.rawBlobPath,occurrence_index_source_fetched_at:index.fetchedAt,
    occurrence_index_card_fingerprint_sha256:index.cardFingerprintSha256,
    occurrence_metadata_evidence_text:(creatureCollectorContent.sourceVersion.index as {metadataEvidenceText:string}).metadataEvidenceText,
  });
  let submitted=false;
  const service = new CompendiumImportReviewService(async (callback) => callback({
    async query(sql:string){if(sql.includes("FROM compendium_import_candidates candidate"))return{rows:[row]};if(sql.includes("FROM sources source LEFT JOIN files"))return{rows:[source()]};return{rows:[],rowCount:1};},
  }),{publish:async()=>{submitted=true;return{commandPath:"/spool/creature",existing:false};},unpublish:async()=>{throw new Error("unused");}},async()=>new Map());
  await assert.rejects(service.act(admin,runId,{candidateIds:[candidateId],action:"approve",activeRevisionTokens:{[candidateId]:null}}),/not publishable/i);
  const result=await service.act(admin,runId,{candidateIds:[candidateId],action:"merge",activeRevisionTokens:{[candidateId]:null},resolvedContent:creatureCollectorContent as unknown as Record<string,unknown>});
  assert.equal(result[0].publicationStatus,"queued");
  assert.equal(submitted,true);
});
