# Issue 87 query-plan follow-up

Migration `0017` adds the indexes used by flat compendium reads: the active
type/edition/language/title keyset index, JSONB containment GIN index, and
numeric expression indexes for feat level and equipment cost/weight.

The automated contracts verify that production SQL uses those exact indexed
expressions. A live `EXPLAIN (ANALYZE, BUFFERS)` remains intentionally pending
until representative production cardinalities exist after migration and NFS
synchronization. Validate list and count plans for every type and access tier;
confirm the GIN/expression index scans win over sequential scans at realistic
selectivity before changing planner settings or adding further indexes.
