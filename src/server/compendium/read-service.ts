import type { QueryResultRow } from "pg";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import {
  buildRetrievalAuthorizationFilter,
  type RetrievalSelection,
  type RetrievalUser,
  type SourceEdition,
  type SourceLanguage,
} from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { COMPENDIUM_ENTRY_TYPES, type CompendiumEntryType } from "./service.ts";

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

export type CompendiumListOptions = RetrievalSelection & Readonly<{
  entryType?: CompendiumEntryType;
  limit?: number;
  offset?: number;
}>;

export type CompendiumListEntry = Readonly<{
  id: string;
  canonicalKey: string;
  entryType: CompendiumEntryType;
  edition: SourceEdition;
  language: SourceLanguage;
  versionId: string;
  slug: string;
  aliases: readonly string[];
  title: string;
  summary: string | null;
  source: PublicSource;
}>;

export type CompendiumEntryTypeCount = Readonly<{ entryType: CompendiumEntryType; count: number }>;

export type PublicSource = Readonly<{
  id: string;
  title: string;
  category: string;
  edition: SourceEdition;
  language: SourceLanguage;
  publication: Readonly<{
    code: string | null;
    title: string;
    publisher: string | null;
    releaseYear: number | null;
    revision: string | null;
    attribution: string | null;
    originUrl: string | null;
  }>;
  license: string | null;
}>;

export type CompendiumEntryDetail = CompendiumListEntry & Readonly<{
  revisionId: string;
  body: string;
  extensionData: Readonly<Record<string, unknown>>;
  projection: Readonly<Record<string, unknown>> | null;
  relations: readonly Readonly<Record<string, unknown>>[];
  sources: readonly Readonly<Record<string, unknown>>[];
  citations: readonly Readonly<Record<string, unknown>>[];
}>;

export class CompendiumNotFoundError extends Error {
  constructor() {
    super("Compendium entry was not found.");
    this.name = "CompendiumNotFoundError";
  }
}

export class CompendiumReadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompendiumReadInputError";
  }
}

const database: Queryable = { query };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EntryRow = QueryResultRow & Readonly<{
  entry_id: string;
  canonical_key: string;
  entry_type: CompendiumEntryType;
  edition: SourceEdition;
  language: SourceLanguage;
  version_id: string;
  revision_id: string;
  slug: string;
  aliases: string[];
  title: string;
  summary: string | null;
  body: string;
  extension_data: Readonly<Record<string, unknown>>;
  projection: Readonly<Record<string, unknown>> | null;
  source_id: string;
  source_title: string;
  source_category: string;
  publication_code: string | null;
  publication_title: string;
  publisher: string | null;
  release_year: number | null;
  publication_revision: string | null;
  attribution: string | null;
  external_origin_url: string | null;
  license: string | null;
  relations: readonly Readonly<Record<string, unknown>>[];
  sources: readonly Readonly<Record<string, unknown>>[];
  citations: readonly Readonly<Record<string, unknown>>[];
}>;

/** Read-only compendium queries. Every query starts from the same source-filtered CTE. */
export class CompendiumReadService {
  private readonly db: Queryable;

  constructor(db: Queryable = database) {
    this.db = db;
  }

  async listEntries(user: RetrievalUser, options: CompendiumListOptions = {}): Promise<Readonly<{
    entries: readonly CompendiumListEntry[];
    count: number;
  }>> {
    validateOptions(options);
    const boundary = buildBoundary(user, options);
    const filters = buildEntryFilters(boundary.params, options);
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    boundary.params.push(limit, offset);
    const limitParam = boundary.params.length - 1;
    const offsetParam = boundary.params.length;

    const [entries, count] = await Promise.all([
      this.db.query<EntryRow>(
        `${boundary.sql}, selected_versions AS (
           SELECT * FROM accessible_versions WHERE source_rank = 1
         )
         ${entrySelect(false)}
         FROM selected_versions av
         WHERE ${filters}
         ORDER BY av.title, av.entry_id, av.language
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        boundary.params,
      ),
      this.countEntries(user, options),
    ]);

    return { entries: entries.rows.map(mapListEntry), count };
  }

  async countEntries(user: RetrievalUser, options: Omit<CompendiumListOptions, "limit" | "offset"> = {}): Promise<number> {
    validateOptions(options);
    const boundary = buildBoundary(user, options);
    const filters = buildEntryFilters(boundary.params, options);
    const result = await this.db.query<{ count: string } & QueryResultRow>(
      `${boundary.sql}, selected_versions AS (
         SELECT * FROM accessible_versions WHERE source_rank = 1
       )
       SELECT count(*)::text AS count FROM selected_versions av WHERE ${filters}`,
      boundary.params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listEntryTypeCounts(user: RetrievalUser, selection: RetrievalSelection = {}): Promise<readonly CompendiumEntryTypeCount[]> {
    const boundary = buildBoundary(user, selection);
    const result = await this.db.query<{ entry_type: CompendiumEntryType; count: string } & QueryResultRow>(
      `${boundary.sql}, selected_versions AS (
         SELECT * FROM accessible_versions WHERE source_rank = 1
       )
       SELECT entry_type, count(*)::text AS count
       FROM selected_versions
       GROUP BY entry_type
       ORDER BY entry_type`,
      boundary.params,
    );
    return result.rows.map((row) => ({ entryType: row.entry_type, count: Number(row.count) }));
  }

  async getEntry(user: RetrievalUser, identifier: string, selection: RetrievalSelection = {}): Promise<CompendiumEntryDetail> {
    const normalized = normalizeIdentifier(identifier);
    const boundary = buildBoundary(user, selection, true);
    boundary.params.push(normalized);
    const identifierParam = boundary.params.length;
    const lookup = UUID_RE.test(normalized)
      ? `av.entry_id = $${identifierParam}::uuid`
      : `EXISTS (
           SELECT 1 FROM compendium_names lookup_name
           WHERE lookup_name.version_id = av.version_id
             AND lookup_name.kind = 'slug'
             AND lookup_name.normalized_name = compendium_normalize_name($${identifierParam})
         )`;

    const result = await this.db.query<EntryRow>(
      `${boundary.sql}, selected_versions AS (
         SELECT * FROM accessible_versions WHERE source_rank = 1
       )
       ${entrySelect(true)},
         ${projectionSelect()},
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'type', rel.relation_type,
             'direction', rel.direction,
             'entryId', target.entry_id,
             'entryType', target.entry_type,
             'slug', target.slug,
             'title', target.title
           ) ORDER BY target.title, target.entry_id)
           FROM (
             SELECT relation_type, target_entry_id AS entry_id, 'outgoing' AS direction
             FROM compendium_entry_relations relation
             WHERE source_entry_id = av.entry_id
               AND ${accessibleRelationEvidence("relation")}
             UNION ALL
             SELECT relation_type, source_entry_id AS entry_id, 'incoming' AS direction
             FROM compendium_entry_relations relation
             WHERE target_entry_id = av.entry_id
               AND ${accessibleRelationEvidence("relation")}
           ) rel
           JOIN selected_versions target ON target.entry_id = rel.entry_id
             AND target.language = av.language
         ), '[]'::jsonb) AS relations,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'versionId', source_version.version_id,
             'sourceId', source_version.source_id,
             'title', source_version.source_title,
             'category', source_version.source_category,
             'slug', source_version.slug
           ) ORDER BY source_version.source_priority DESC, source_version.version_id)
           FROM accessible_versions source_version
           WHERE source_version.entry_id = av.entry_id
             AND source_version.language = av.language
         ), '[]'::jsonb) AS sources,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'id', citation.id,
             'kind', citation.kind,
             'fieldPath', citation.field_path,
             'blockOrder', citation.block_order,
              'quote', citation.quote,
              'chunkId', citation.chunk_id,
              'fileId', citation.file_id,
              'sourceId', citation.source_id,
              'page', evidence.page_number,
              'section', evidence.section_heading
            ) ORDER BY citation.kind, citation.field_path, citation.block_order)
            FROM compendium_citations citation
            LEFT JOIN chunks evidence ON evidence.id = citation.chunk_id
              AND evidence.source_id = citation.source_id
              AND evidence.file_id = citation.file_id
              AND evidence.generation_id = citation.generation_id
            WHERE citation.version_id = av.version_id
             AND citation.revision_id = av.revision_id
             AND citation.source_id = av.source_id
             AND citation.file_id = av.file_id
         ), '[]'::jsonb) AS citations
       FROM selected_versions av
       WHERE ${lookup}
       ORDER BY av.language, av.entry_id
       LIMIT 1`,
      boundary.params,
    );
    if (!result.rows[0]) throw new CompendiumNotFoundError();
    return mapDetail(result.rows[0]);
  }

  async resolveAlias(user: RetrievalUser, alias: string, selection: RetrievalSelection = {}): Promise<CompendiumEntryDetail> {
    const normalized = normalizeIdentifier(alias);
    const boundary = buildBoundary(user, selection);
    boundary.params.push(normalized);
    const aliasParam = boundary.params.length;
    const result = await this.db.query<{ entry_id: string } & QueryResultRow>(
      `${boundary.sql}, selected_versions AS (
         SELECT * FROM accessible_versions WHERE source_rank = 1
       )
       SELECT av.entry_id
       FROM selected_versions av
       JOIN compendium_names n ON n.version_id = av.version_id AND n.kind = 'alias'
       WHERE n.normalized_name = compendium_normalize_name($${aliasParam})
       ORDER BY av.language, av.entry_id
       LIMIT 1`,
      boundary.params,
    );
    if (!result.rows[0]) throw new CompendiumNotFoundError();
    return this.getEntry(user, result.rows[0].entry_id, selection);
  }

  async getSource(user: RetrievalUser, sourceId: string): Promise<PublicSource> {
    if (!UUID_RE.test(sourceId)) throw new CompendiumNotFoundError();
    const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user));
    const params = [...access.params, sourceId];
    const result = await this.db.query<SourceRow & QueryResultRow>(
      `SELECT s.id, s.title, s.category, s.edition, s.language,
               s.publication_code, s.publication_title, s.publisher, s.release_year,
               s.publication_revision, s.external_origin_url, s.attribution, s.license
       FROM sources s
       WHERE ${access.sql}
         AND s.deleted_at IS NULL
         AND s.id = $${params.length}::uuid
       LIMIT 1`,
      params,
    );
    if (!result.rows[0]) throw new CompendiumNotFoundError();
    return mapPublicSource(result.rows[0]);
  }
}

type SourceRow = Readonly<{
  id: string;
  title: string;
  category: string;
  edition: SourceEdition;
  language: SourceLanguage;
  publication_code: string | null;
  publication_title: string;
  publisher: string | null;
  release_year: number | null;
  publication_revision: string | null;
  attribution: string | null;
  external_origin_url: string | null;
  license: string | null;
}>;

function buildBoundary(
  user: RetrievalUser,
  selection: RetrievalSelection,
  includeDetailFields = false,
): { sql: string; params: unknown[] } {
  const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, selection));
  return {
    params: [...access.params],
    sql: `WITH accessible_versions AS MATERIALIZED (
      SELECT
        e.id AS entry_id, e.canonical_key, e.entry_type, e.edition,
        v.id AS version_id, v.language, v.source_id, v.file_id,
        r.id AS revision_id, r.title, r.summary,${includeDetailFields ? " r.body, r.extension_data," : ""}
        s.title AS source_title, s.category AS source_category, s.source_priority,
        s.publication_code, s.publication_title, s.publisher, s.release_year,
        s.publication_revision, s.external_origin_url, s.attribution, s.license,
        slug.name AS slug,
        row_number() OVER (
          PARTITION BY e.id, v.language
          ORDER BY s.source_priority DESC, v.published_at DESC, v.id
        ) AS source_rank
      FROM compendium_versions v
      JOIN compendium_entries e ON e.id = v.entry_id
      JOIN compendium_revisions r ON r.id = v.active_revision_id AND r.version_id = v.id
      JOIN sources s ON s.id = v.source_id
      JOIN files f ON f.id = v.file_id AND f.source_id = s.id
      JOIN compendium_names slug ON slug.version_id = v.id AND slug.kind = 'slug'
      WHERE ${access.sql}
        AND s.deleted_at IS NULL
        AND f.deleted_at IS NULL
        AND v.lifecycle = 'published'
        AND r.lifecycle = 'published'
    )`,
  };
}

function buildEntryFilters(params: unknown[], options: Pick<CompendiumListOptions, "entryType">): string {
  if (!options.entryType) return "1=1";
  params.push(options.entryType);
  return `av.entry_type = $${params.length}`;
}

function entrySelect(includeDetailFields: boolean): string {
  return `SELECT
    av.entry_id, av.canonical_key, av.entry_type, av.edition, av.language,
    av.version_id, av.revision_id, av.slug,
    ARRAY(
      SELECT n.name FROM compendium_names n
      WHERE n.version_id = av.version_id AND n.kind = 'alias'
      ORDER BY n.normalized_name
    ) AS aliases,
    av.title, av.summary,${includeDetailFields ? " av.body, av.extension_data," : ""}
    av.source_id, av.source_title, av.source_category,
    av.publication_code, av.publication_title, av.publisher, av.release_year,
    av.publication_revision, av.external_origin_url, av.attribution, av.license`;
}

function accessibleRelationEvidence(relationAlias: string): string {
  return `EXISTS (
    SELECT 1
    FROM compendium_import_links provenance
    JOIN accessible_versions evidence ON evidence.version_id = provenance.evidence_version_id
    WHERE provenance.relation_id = ${relationAlias}.id
  )`;
}

function projectionSelect(): string {
  const tables: Record<CompendiumEntryType, string> = {
    spell: "compendium_spells",
    creature: "compendium_creatures",
    item: "compendium_items",
    class: "compendium_classes",
    feature: "compendium_features",
    species: "compendium_species",
    background: "compendium_backgrounds",
    feat: "compendium_feats",
    equipment: "compendium_equipment",
    glossary: "compendium_glossary",
  };
  const cases = Object.entries(tables).map(
    ([type, table]) => `WHEN '${type}' THEN (SELECT to_jsonb(p) - 'revision_id' - 'entry_type' FROM ${table} p WHERE p.revision_id = av.revision_id)`,
  );
  return `CASE av.entry_type ${cases.join(" ")} END AS projection`;
}

function validateOptions(options: CompendiumListOptions | Omit<CompendiumListOptions, "limit" | "offset">): void {
  if (options.entryType && !COMPENDIUM_ENTRY_TYPES.includes(options.entryType)) {
    throw new CompendiumReadInputError("Unsupported compendium entry type.");
  }
  if ("limit" in options && options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
    throw new CompendiumReadInputError("limit must be an integer from 1 to 200.");
  }
  if ("offset" in options && options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) {
    throw new CompendiumReadInputError("offset must be a nonnegative integer.");
  }
}

function normalizeIdentifier(value: string): string {
  const normalized = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!normalized || normalized.length > 256) throw new CompendiumNotFoundError();
  return normalized;
}

function mapListEntry(row: EntryRow): CompendiumListEntry {
  return {
    id: row.entry_id,
    canonicalKey: row.canonical_key,
    entryType: row.entry_type,
    edition: row.edition,
    language: row.language,
    versionId: row.version_id,
    slug: row.slug,
    aliases: row.aliases,
    title: row.title,
    summary: row.summary,
    source: mapPublicSource({
      id: row.source_id,
      title: row.source_title,
      category: row.source_category,
      edition: row.edition,
      language: row.language,
      publication_code: row.publication_code,
      publication_title: row.publication_title,
      publisher: row.publisher,
      release_year: row.release_year,
      publication_revision: row.publication_revision,
      external_origin_url: row.external_origin_url,
      attribution: row.attribution,
      license: row.license,
    }),
  };
}

function mapDetail(row: EntryRow): CompendiumEntryDetail {
  return {
    ...mapListEntry(row),
    revisionId: row.revision_id,
    body: row.body,
    extensionData: row.extension_data,
    projection: row.projection,
    relations: row.relations,
    sources: row.sources,
    citations: row.citations,
  };
}

function mapPublicSource(row: SourceRow): PublicSource {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    edition: row.edition,
    language: row.language,
    publication: {
      code: row.publication_code,
      title: row.publication_title,
      publisher: row.publisher,
      releaseYear: row.release_year,
      revision: row.publication_revision,
      attribution: row.attribution,
      originUrl: row.external_origin_url ?? null,
    },
    license: row.license,
  };
}
