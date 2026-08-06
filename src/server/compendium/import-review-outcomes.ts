import type { QueryResultRow } from "pg";

import { withTransaction } from "../db/client.ts";

export type ReviewPublicationOutcome = "completed" | "failed";
type OutcomeTransaction = typeof withTransaction;

export async function recordImportReviewPublicationOutcome(
  idempotencyKey: string,
  status: ReviewPublicationOutcome,
  lastError: string | null,
  transaction: OutcomeTransaction = withTransaction,
): Promise<void> {
  if (!idempotencyKey.startsWith("review-")) return;
  if (status === "failed" && !lastError) throw new TypeError("Failed publication outcomes require an error.");
  await transaction(async (client) => {
    const updated = await client.query<QueryResultRow & {
      import_run_id: string;
      candidate_id: string;
      reviewed_by: string;
    }>(
      `UPDATE compendium_import_candidate_reviews
       SET publication_status = $2, last_error = $3, updated_at = now()
       WHERE idempotency_key = $1 AND publication_status <> 'completed'
         AND (publication_status IS DISTINCT FROM $2 OR last_error IS DISTINCT FROM $3)
       RETURNING import_run_id, candidate_id, reviewed_by`,
      [idempotencyKey, status, status === "failed" ? lastError : null],
    );
    const review = updated.rows[0];
    if (!review) return;
    await client.query(
      `INSERT INTO compendium_import_review_audit
         (import_run_id, candidate_id, event_type, actor, initiating_actor, details)
       VALUES ($1,$2,$3,'publication-worker',$4,$5::jsonb)`,
      [review.import_run_id, review.candidate_id, `publication_${status}`, review.reviewed_by,
        JSON.stringify(lastError ? { error: lastError } : {})],
    );
  });
}
