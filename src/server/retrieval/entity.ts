import type { QueryResult, QueryResultRow } from "pg";

import { query } from "../db/client.ts";
import type { RetrievalSelection, SourceEdition, SourceLanguage } from "../access/retrieval-filter.ts";
import type { EntityEvidence, RetrievalCandidate } from "./types.ts";

export type CompendiumEntryScope = Readonly<{
  entryId: string;
  sourceId?: string;
  versionId?: string;
  edition?: SourceEdition;
  language?: SourceLanguage;
}>;

export type ExactEntityMatch = Readonly<{
  entryId: string;
  entryType: string;
  canonicalKey: string;
  title: string;
  aliases: readonly string[];
  edition: string;
  language: string;
  sourceId: string;
}>;

export type EntityResolution = Readonly<{
  matches: readonly ExactEntityMatch[];
  candidates: readonly RetrievalCandidate[];
}>;

type QueryExecutor = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<QueryResult<T>>;

type EntityRow = QueryResultRow & {
  entry_id: string;
  entry_type: string;
  canonical_key: string;
  title: string;
  aliases: string[];
  edition: string;
  language: string;
  source_id: string;
  file_id: string;
  source_title: string;
  source_category: string;
  access_tier: string;
  chunk_id: string;
  text: string;
  quote_text: string;
  section_heading: string | null;
  page_number: number | null;
  citation_id: string;
  citation_kind: "field" | "block";
  field_path: string | null;
  citation_quote: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EntityLookupPlan = Readonly<{
  params: readonly unknown[];
  matchPredicate: string;
}>;

export function normalizeEntityLookupName(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replaceAll(/[-_\s.,/:;!?()]+/gu, "-")
    .replaceAll(/^-|-$/g, "");
}

export function isCompendiumEntryScope(value: unknown): value is CompendiumEntryScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return UUID_RE.test(String(scope.entryId ?? ""))
    && (scope.sourceId === undefined || UUID_RE.test(String(scope.sourceId)))
    && (scope.versionId === undefined || UUID_RE.test(String(scope.versionId)))
    && (scope.edition === undefined || scope.edition === "5e" || scope.edition === "5.5e")
    && (scope.language === undefined || scope.language === "en" || scope.language === "ru");
}

export function entryScopeConflictsWithSelection(
  scope: CompendiumEntryScope,
  selection: RetrievalSelection,
): boolean {
  return (scope.edition !== undefined && selection.edition !== undefined && scope.edition !== selection.edition)
    || (scope.language !== undefined && selection.language !== undefined && scope.language !== selection.language);
}

export function prepareEntityLookup(
  searchQuery: string,
  generationIds: readonly string[],
  scope?: CompendiumEntryScope,
): EntityLookupPlan | null {
  if (generationIds.length === 0) return null;

  const params: unknown[] = [generationIds];
  if (scope) {
    if (!isCompendiumEntryScope(scope)) return null;
    const scopeFilters: string[] = [];
    params.push(scope.entryId);
    scopeFilters.push(`e.id = $${params.length}::uuid`);
    if (scope.sourceId) {
      params.push(scope.sourceId);
      scopeFilters.push(`v.source_id = $${params.length}::uuid`);
    }
    if (scope.versionId) {
      params.push(scope.versionId);
      scopeFilters.push(`v.id = $${params.length}::uuid`);
    }
    if (scope.edition) {
      params.push(scope.edition);
      scopeFilters.push(`e.edition = $${params.length}`);
    }
    if (scope.language) {
      params.push(scope.language);
      scopeFilters.push(`v.language = $${params.length}`);
    }
    return { params, matchPredicate: scopeFilters.join(" AND ") };
  }

  const boundedQuery = searchQuery.slice(0, 500);
  if (!normalizeEntityLookupName(boundedQuery)) return null;
  params.push(boundedQuery);
  const queryParam = params.length;
  return {
    params,
    matchPredicate: `(
      position('-' || compendium_normalize_name(r.title) || '-' in '-' || compendium_normalize_name($${queryParam}) || '-') > 0
      OR EXISTS (
        SELECT 1 FROM compendium_names exact_name
        WHERE exact_name.version_id = v.id
          AND position('-' || exact_name.normalized_name || '-' in '-' || compendium_normalize_name($${queryParam}) || '-') > 0
      )
    )`,
  };
}

/**
 * Resolves exact titles/aliases and returns only their source-bound citations
 * whose chunks belong to the request's fixed authorized generation snapshot.
 */
export async function resolveCompendiumEntities(
  searchQuery: string,
  generationIds: readonly string[],
  scope?: CompendiumEntryScope,
  execute: QueryExecutor = query,
): Promise<EntityResolution> {
  const plan = prepareEntityLookup(searchQuery, generationIds, scope);
  if (!plan) return { matches: [], candidates: [] };

  const result = await execute<EntityRow>(
    `WITH matched_versions AS MATERIALIZED (
       SELECT e.id AS entry_id, e.entry_type::text, e.canonical_key, e.edition::text,
              v.id AS version_id, v.language::text, v.source_id, v.file_id,
              r.id AS revision_id, r.title,
              ARRAY(SELECT n.name FROM compendium_names n WHERE n.version_id=v.id AND n.kind='alias' ORDER BY n.normalized_name) AS aliases
       FROM compendium_entries e
       JOIN compendium_versions v ON v.entry_id=e.id AND v.entry_type=e.entry_type AND v.edition=e.edition
       JOIN compendium_revisions r ON r.id=v.active_revision_id AND r.version_id=v.id
       WHERE v.lifecycle='published' AND r.lifecycle='published' AND ${plan.matchPredicate}
     )
     SELECT matched.entry_id, matched.entry_type, matched.canonical_key, matched.title,
            matched.aliases, matched.edition, matched.language, matched.source_id,
            matched.file_id, s.title AS source_title, s.category AS source_category,
            s.access_tier::text, c.id AS chunk_id, c.text, c.quote_text,
            c.section_heading, c.page_number, citation.id AS citation_id,
            citation.kind::text AS citation_kind, citation.field_path,
            citation.quote AS citation_quote
     FROM matched_versions matched
     JOIN compendium_citations citation
       ON citation.version_id=matched.version_id AND citation.revision_id=matched.revision_id
      AND citation.source_id=matched.source_id AND citation.file_id=matched.file_id
     JOIN chunks c ON c.id=citation.chunk_id AND c.generation_id=citation.generation_id
      AND c.source_id=citation.source_id AND c.file_id=citation.file_id
     JOIN files f ON f.id=matched.file_id AND f.source_id=matched.source_id
     JOIN sources s ON s.id=matched.source_id
     WHERE citation.generation_id = ANY($1::uuid[])
       AND f.deleted_at IS NULL AND s.deleted_at IS NULL
     ORDER BY matched.entry_type, matched.entry_id, s.source_priority DESC,
              matched.language, citation.kind, citation.field_path, citation.block_order
     LIMIT 200`,
    plan.params,
  );

  return mapEntityRows(result.rows);
}

function mapEntityRows(rows: readonly EntityRow[]): EntityResolution {
  const matches = new Map<string, ExactEntityMatch>();
  const candidates = new Map<string, RetrievalCandidate>();

  for (const row of rows) {
    const matchKey = `${row.entry_id}:${row.source_id}:${row.language}`;
    if (!matches.has(matchKey)) {
      matches.set(matchKey, {
        entryId: row.entry_id,
        entryType: row.entry_type,
        canonicalKey: row.canonical_key,
        title: row.title,
        aliases: row.aliases,
        edition: row.edition,
        language: row.language,
        sourceId: row.source_id,
      });
    }

    const evidence: EntityEvidence = {
      entryId: row.entry_id,
      entryType: row.entry_type,
      canonicalKey: row.canonical_key,
      title: row.title,
      citationId: row.citation_id,
      citationKind: row.citation_kind,
      fieldPath: row.field_path,
      quote: row.citation_quote,
    };
    const existing = candidates.get(row.chunk_id);
    if (existing) {
      candidates.set(row.chunk_id, {
        ...existing,
        score: Math.max(existing.score, row.citation_kind === "field" ? 1 : 0.9),
        entityEvidence: [...(existing.entityEvidence ?? []), evidence],
      });
      continue;
    }

    candidates.set(row.chunk_id, {
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      fileId: row.file_id,
      text: row.text,
      quoteText: row.quote_text,
      sectionHeading: row.section_heading,
      pageNumber: row.page_number,
      edition: row.edition,
      language: row.language,
      sourceTitle: row.source_title,
      sourceCategory: row.source_category,
      accessTier: row.access_tier,
      score: row.citation_kind === "field" ? 1 : 0.9,
      strategy: "entity",
      entityEvidence: [evidence],
    });
  }

  return { matches: [...matches.values()], candidates: [...candidates.values()] };
}

export function enrichRewriteWithEntities<T extends Readonly<{
  original: string;
  canonical: string;
  bilingual: readonly string[];
  expanded: readonly string[];
}>>(rewrite: T, matches: readonly ExactEntityMatch[]): T {
  if (matches.length === 0) return rewrite;
  const names = matches.flatMap((match) => [match.title, ...match.aliases]);
  const seen = new Set([rewrite.original, rewrite.canonical, ...rewrite.bilingual, ...rewrite.expanded].map(normalizeEntityLookupName));
  const additions = names.filter((name) => {
    const key = normalizeEntityLookupName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...rewrite, expanded: [...rewrite.expanded, ...additions] };
}
