import assert from "node:assert/strict";
import test from "node:test";

import { recordImportReviewPublicationOutcome } from "../../src/server/compendium/import-review-outcomes.ts";

test("worker outcome audit keeps system actor and initiating reviewer separate", async () => {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const transaction = async (callback: (client: { query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<void>) => callback({
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.startsWith("UPDATE compendium_import_candidate_reviews")) return { rows: [{ import_run_id: "run", candidate_id: "candidate", reviewed_by: "reviewer-user" }] };
      return { rows: [] };
    },
  });
  await recordImportReviewPublicationOutcome("review-command", "completed", null, transaction as never);
  const audit = statements.find((statement) => statement.sql.includes("INSERT INTO compendium_import_review_audit"));
  assert.ok(audit?.sql.includes("'publication-worker'"));
  assert.equal(audit?.values[3], "reviewer-user");
  assert.equal(statements.some((statement) => statement.sql.includes("publication-system")), false);
});

test("non-review commands do not touch review state", async () => {
  let called = false;
  await recordImportReviewPublicationOutcome("ordinary-command", "completed", null, (async () => { called = true; }) as never);
  assert.equal(called, false);
});
