import assert from "node:assert/strict";
import test from "node:test";

import { CompendiumImportReviewService } from "../../src/server/compendium/import-review.ts";

const runId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const admin = { userId: "44444444-4444-4444-8444-444444444444", role: "admin" } as const;
const activeRevision = `rev-${"b".repeat(64)}`;
const secondCandidateId = "66666666-6666-4666-8666-666666666666";
const plain = "Magic missile strikes its target.";
const content = {
  entry: { entryType: "spell", name: "Magic Missile", aliases: [], typedFields: [] },
  text: { plain, sections: [{ sectionId: "description", heading: "Description", text: plain, startOffset: 0, endOffset: plain.length }] },
  citations: [{ citationId: "primary", sourceId: "players-handbook", fileId, page: 257, section: "Magic Missile", quote: plain, startOffset: 0, endOffset: plain.length }],
};

function candidate(overrides: Record<string, unknown> = {}) {
  return { id: candidateId, import_run_id: runId, candidate_key: "magic-missile", entry_type: "spell", diff_status: "new", content,
    previous_content: null, invalid_reason: null, locator: "page:257", chunk_id: null, page_number: 257,
    created_at: "2026-08-06T00:00:00.000Z", run_status: "succeeded", decision: null, resolved_content: null,
    publication_status: null, publication_attempt: null, idempotency_key: null, last_error: null, reviewed_by: null, reviewed_at: null,
    expected_active_revision_id: null, expected_active_revision_captured: false,
    ...overrides };
}

function source() {
  return { canonical_source_id: "players-handbook", title: "Player's Handbook", category: "core_rules", edition: "5e", language: "en",
    access_tier: "open", shared: false, owner_user_id: null, publication_code: "PHB", publication_title: "Player's Handbook",
    publisher: "Wizards", release_year: 2014, publication_revision: null, external_origin_url: null, external_origin_id: null,
    attribution: null, source_priority: 100, canonical_book_id: "players-handbook", license: null,
    canonical_files: [{ fileId, path: `sources/players-handbook/files/${fileId}.pdf`, mediaType: "application/pdf", contentHash: `sha256:${"a".repeat(64)}` }] };
}

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
  assert.equal((submitted as { revision: { entryId: string } }).revision.entryId, "magic-missile");
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
  }, async (entryIds) => { reads++; return new Map(entryIds.map((entryId) => [entryId, canonicalToken])); });
  const displayed = await service.getRun(admin, runId);
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
  const candidates = [candidate(), candidate({ id: secondCandidateId, candidate_key: "shield" })];
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
  assert.deepEqual(Object.fromEntries(submitted), { "magic-missile": null, shield: secondToken });
});
