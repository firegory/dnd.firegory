/**
 * Shared SQL builder for retrieval access filters.
 *
 * Generates parameterized SQL WHERE clauses from a RetrievalAuthorizationFilter.
 * This is the single source of truth for access filter SQL generation,
 * used by both the hybrid retrieval pipeline and the search service.
 */

import type { RetrievalAuthorizationFilter, SourceAccessClause } from "./retrieval-filter";

/**
 * Generates a SQL WHERE clause fragment and params for a single SourceAccessClause.
 */
function accessClauseToSql(
  clause: SourceAccessClause,
  params: unknown[],
): string {
  if (clause.accessTier === "open") {
    return "(s.access_tier = 'open')";
  }

  if (clause.accessTier === "premium") {
    return "(s.access_tier = 'premium' AND s.shared = true)";
  }

  // personal
  params.push(clause.ownerUserId);
  const idx = params.length;
  return `(s.access_tier = 'personal' AND s.owner_user_id = $${idx})`;
}

/**
 * Builds the full SQL WHERE clause and parameters from a RetrievalAuthorizationFilter.
 *
 * Returns `{ sql, params }` where `sql` is a parenthesized WHERE expression
 * referencing source table alias "s", and `params` are the corresponding values.
 *
 * The filter's edition/language/category fields add equality conditions.
 * The filter's access field adds role-appropriate access tier conditions.
 */
export function buildSourceAccessSql(
  filter: RetrievalAuthorizationFilter,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Corpus narrowing filters (edition, language, category)
  if (filter.edition) {
    params.push(filter.edition);
    conditions.push(`s.edition = $${params.length}`);
  }

  if (filter.language) {
    params.push(filter.language);
    conditions.push(`s.language = $${params.length}`);
  }

  if (filter.category) {
    params.push(filter.category);
    conditions.push(`s.category = $${params.length}`);
  }

  // Access tier conditions
  if (filter.access.kind === "all") {
    // Admin — no access restriction
  } else {
    const clauseSql = filter.access.clauses.map(
      (clause) => accessClauseToSql(clause, params),
    );
    conditions.push(`(${clauseSql.join(" OR ")})`);
  }

  return {
    sql: conditions.length > 0 ? conditions.join(" AND ") : "1=1",
    params,
  };
}
