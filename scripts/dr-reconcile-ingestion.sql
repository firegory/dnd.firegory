BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended('dnd-firegory-dr-ingestion-reconcile', 0));

WITH reconciled AS (
  UPDATE ingestion_jobs
  SET status = CASE status
        WHEN 'processing' THEN 'failed'::ingestion_job_status
        ELSE 'cancelled'::ingestion_job_status
      END,
      finished_at = clock_timestamp(),
      error_summary = CASE status
        WHEN 'processing' THEN 'Disaster recovery interrupted processing and the upload spool was not restored. Re-upload the original file and start a new ingestion job.'
        ELSE 'Disaster recovery did not restore the queued upload spool. Re-upload the original file and start a new ingestion job.'
      END
  WHERE status IN ('queued', 'processing')
  RETURNING id, status
)
SELECT status, count(*) AS reconciled_jobs
FROM reconciled
GROUP BY status
ORDER BY status;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ingestion_jobs WHERE status IN ('queued', 'processing')) THEN
    RAISE EXCEPTION 'active ingestion jobs remain after DR reconciliation';
  END IF;
END $$;

COMMIT;
