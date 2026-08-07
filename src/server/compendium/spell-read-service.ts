import type { QueryResultRow } from "pg";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import { buildRetrievalAuthorizationFilter, type RetrievalSelection, type RetrievalUser } from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { SPELL_SCHOOLS, spellProjectionFromTypedFields, type SpellProjection, type SpellSchool } from "./spell-schema.ts";

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

export type SpellListOptions = RetrievalSelection & Readonly<{
  levels?: readonly number[];
  schools?: readonly SpellSchool[];
  ritual?: boolean;
  concentration?: boolean;
  className?: string;
  castingTime?: string;
  range?: string;
  duration?: string;
  components?: readonly string[];
  query?: string;
  cursor?: string;
  limit?: number;
}>;

export type SpellCitation = Readonly<{
  id: string;
  quote: string;
  section: string;
  page: number;
  sourceId: string;
  fileId: string;
  previewUrl: string | null;
}>;

export type SpellListEntry = SpellProjection & Readonly<{
  id: string;
  revisionId: string;
  title: string;
  aliases: readonly string[];
  summary: string;
  edition: string;
  language: string;
  source: Readonly<{ id: string; title: string; code: string | null; revision: string | null }>;
}>;

export type SpellDetail = SpellListEntry & Readonly<{
  body: string;
  citations: readonly SpellCitation[];
  sourceVersions: readonly Readonly<{
    sourceId: string; title: string; code: string | null; revision: string | null; revisionId: string;
  }>[];
}>;

export class SpellReadInputError extends Error {}
export class SpellNotFoundError extends Error {}

type SpellRow = QueryResultRow & Readonly<{
  entry_id: string; revision_id: string; name: string; aliases: unknown; typed_fields: unknown;
  plain_text: string; canonical_payload: Record<string, unknown>; source_id: string; file_id: string; mime_type: string;
  source_title: string; edition: string; language: string; publication_code: string | null;
  publication_revision: string | null; sort_title: string; source_versions: unknown;
}>;

const database: Queryable = { query };
const STABLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export class SpellReadService {
  private readonly db: Queryable;

  constructor(db: Queryable = database) {
    this.db = db;
  }

  async list(user: RetrievalUser, options: SpellListOptions = {}): Promise<Readonly<{
    spells: readonly SpellListEntry[]; count: number; nextCursor: string | null;
  }>> {
    validateOptions(options);
    const boundary = boundarySql(user, options);
    const filters = spellFilters(boundary.params, options);
    const limit = options.limit ?? 24;
    boundary.params.push(limit + 1);
    const result = await this.db.query<SpellRow>(
      `${boundary.sql}
       SELECT * FROM accessible_spells spell
       WHERE ${filters}
       ORDER BY spell.sort_title COLLATE "C", spell.entry_id
       LIMIT $${boundary.params.length}`,
      boundary.params,
    );
    const visible = result.rows.slice(0, limit);
    const countOptions = { ...options };
    delete countOptions.cursor;
    delete countOptions.limit;
    const count = await this.count(user, countOptions);
    const last = visible.at(-1);
    return {
      spells: visible.map(mapListEntry), count,
      nextCursor: result.rows.length > limit && last ? encodeCursor(last.sort_title, last.entry_id) : null,
    };
  }

  async count(user: RetrievalUser, options: Omit<SpellListOptions, "limit" | "cursor"> = {}): Promise<number> {
    validateOptions(options);
    const boundary = boundarySql(user, options);
    const filters = spellFilters(boundary.params, options);
    const result = await this.db.query<{ count: string } & QueryResultRow>(
      `${boundary.sql} SELECT count(*)::text AS count FROM accessible_spells spell WHERE ${filters}`,
      boundary.params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async get(user: RetrievalUser, identifier: string, selection: RetrievalSelection = {}): Promise<SpellDetail> {
    if (!STABLE_ID.test(identifier)) throw new SpellNotFoundError();
    const boundary = boundarySql(user, selection);
    boundary.params.push(identifier);
    const result = await this.db.query<SpellRow>(
      `${boundary.sql}
       SELECT * FROM accessible_spells spell
       WHERE spell.entry_id = $${boundary.params.length}
       ORDER BY spell.source_priority DESC, spell.revision_id
       LIMIT 1`,
      boundary.params,
    );
    const row = result.rows[0];
    if (!row) throw new SpellNotFoundError();
    return mapDetail(row);
  }
}

function boundarySql(user: RetrievalUser, selection: RetrievalSelection): { sql: string; params: unknown[] } {
  const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, selection));
  return {
    params: [...access.params],
    sql: `WITH accessible_spell_versions AS MATERIALIZED (
      SELECT n.entry_id, n.revision_id, n.name, n.aliases, n.typed_fields, n.plain_text,
             n.canonical_payload, n.source_id, n.file_id, f.mime_type, s.title AS source_title,
             s.edition, s.language, s.publication_code, s.publication_revision, s.source_priority,
             lower(n.name) AS sort_title,
             row_number() OVER (
               PARTITION BY n.entry_id
               ORDER BY s.source_priority DESC, n.indexed_at DESC, n.revision_id
             ) AS source_rank,
             (SELECT jsonb_object_agg(field->>'key', field->'value')
              FROM jsonb_array_elements(n.typed_fields) field) AS attributes
      FROM nfs_index_entries n
      JOIN sources s ON s.id = n.source_id
      JOIN files f ON f.id = n.file_id AND f.source_id = s.id
      WHERE ${access.sql} AND s.deleted_at IS NULL AND f.deleted_at IS NULL
        AND n.lifecycle = 'active' AND n.entry_type = 'spell'
    ), accessible_spells AS MATERIALIZED (
      SELECT spell_version.*,
             (SELECT jsonb_agg(jsonb_build_object(
                'sourceId', source_version.source_id, 'title', source_version.source_title,
                'code', source_version.publication_code, 'revision', source_version.publication_revision,
                'revisionId', source_version.revision_id
              ) ORDER BY source_version.source_priority DESC, source_version.revision_id)
              FROM accessible_spell_versions source_version
              WHERE source_version.entry_id = spell_version.entry_id) AS source_versions
      FROM accessible_spell_versions spell_version
      WHERE spell_version.source_rank = 1
    )`,
  };
}

function spellFilters(params: unknown[], options: SpellListOptions | Omit<SpellListOptions, "limit" | "cursor">): string {
  const filters = ["1=1"];
  if (options.levels?.length) filters.push(`(spell.attributes->>'level')::integer = ANY($${params.push(options.levels)}::integer[])`);
  if (options.schools?.length) filters.push(`spell.attributes->>'school' = ANY($${params.push(options.schools)}::text[])`);
  if (options.ritual !== undefined) filters.push(`(spell.attributes->>'ritual')::boolean = $${params.push(options.ritual)}`);
  if (options.concentration !== undefined) filters.push(`(spell.attributes->>'concentration')::boolean = $${params.push(options.concentration)}`);
  if (options.className) filters.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(spell.attributes->'classes', '[]'::jsonb)) class_name WHERE lower(class_name) = lower($${params.push(options.className)}))`);
  if (options.castingTime) filters.push(`spell.attributes->>'casting-time' ILIKE $${params.push(`%${escapeLike(options.castingTime)}%`)} ESCAPE '\\'`);
  if (options.range) filters.push(`spell.attributes->>'range' ILIKE $${params.push(`%${escapeLike(options.range)}%`)} ESCAPE '\\'`);
  if (options.duration) filters.push(`spell.attributes->>'duration' ILIKE $${params.push(`%${escapeLike(options.duration)}%`)} ESCAPE '\\'`);
  for (const component of options.components ?? []) {
    filters.push(`spell.attributes->>'components' ILIKE $${params.push(`%${escapeLike(component)}%`)} ESCAPE '\\'`);
  }
  if (options.query) filters.push(`(spell.name ILIKE $${params.push(`%${escapeLike(options.query)}%`)} ESCAPE '\\' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(spell.aliases) alias WHERE alias ILIKE $${params.length} ESCAPE '\\'))`);
  if ("cursor" in options && options.cursor) {
    const cursor = decodeCursor(options.cursor);
    params.push(cursor.title, cursor.id);
    filters.push(`(spell.sort_title COLLATE "C", spell.entry_id) > ($${params.length - 1} COLLATE "C", $${params.length})`);
  }
  return filters.join(" AND ");
}

function validateOptions(options: SpellListOptions | Omit<SpellListOptions, "limit" | "cursor">): void {
  if (options.levels?.some((level) => !Number.isSafeInteger(level) || level < 0 || level > 9)) throw new SpellReadInputError("Invalid spell level.");
  if (options.schools?.some((school) => !SPELL_SCHOOLS.includes(school))) throw new SpellReadInputError("Invalid spell school.");
  if (options.className !== undefined && (!options.className.trim() || options.className.length > 80)) throw new SpellReadInputError("Invalid spell class.");
  for (const [name, value] of [["casting time", options.castingTime], ["range", options.range], ["duration", options.duration]] as const) {
    if (value !== undefined && (!value.trim() || value.length > 120)) throw new SpellReadInputError(`Invalid spell ${name}.`);
  }
  if (options.components?.some((component) => !component.trim() || component.length > 40) || (options.components?.length ?? 0) > 8) {
    throw new SpellReadInputError("Invalid spell components.");
  }
  if (options.query !== undefined && (!options.query.trim() || options.query.length > 120)) throw new SpellReadInputError("Invalid spell query.");
  if ("limit" in options && options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new SpellReadInputError("limit must be from 1 to 100.");
  if ("cursor" in options && options.cursor) decodeCursor(options.cursor);
}

function mapListEntry(row: SpellRow): SpellListEntry {
  const projection = spellProjectionFromTypedFields(row.typed_fields);
  return {
    id: row.entry_id, revisionId: row.revision_id, title: row.name,
    aliases: stringArray(row.aliases), summary: firstSentence(row.plain_text),
    edition: row.edition, language: row.language,
    source: { id: row.source_id, title: row.source_title, code: row.publication_code, revision: row.publication_revision },
    ...projection,
  };
}

function mapDetail(row: SpellRow): SpellDetail {
  const base = mapListEntry(row);
  const payload = row.canonical_payload;
  const citations = Array.isArray(payload.citations) ? payload.citations.flatMap((value, index) => {
    if (!isRecord(value) || !Number.isSafeInteger(value.page) || typeof value.quote !== "string") return [];
    const page = Number(value.page);
    return [{
      id: typeof value.citationId === "string" ? value.citationId : `citation-${index + 1}`,
      quote: value.quote, section: typeof value.section === "string" ? value.section : base.title,
      page, sourceId: row.source_id, fileId: row.file_id,
       previewUrl: row.mime_type === "application/pdf"
         ? `/api/citations/preview?sourceId=${encodeURIComponent(row.source_id)}&fileId=${encodeURIComponent(row.file_id)}&page=${page}`
         : null,
    }];
  }) : [];
  return {
    ...base, body: row.plain_text, citations,
    sourceVersions: sourceVersions(row.source_versions),
  };
}

function encodeCursor(title: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, title, id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { title: string; id: string } {
  try {
    if (value.length > 512) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(decoded) || decoded.v !== 1 || typeof decoded.title !== "string" || typeof decoded.id !== "string" || !STABLE_ID.test(decoded.id)) throw new Error();
    return { title: decoded.title, id: decoded.id };
  } catch {
    throw new SpellReadInputError("Invalid spell cursor.");
  }
}

function escapeLike(value: string): string { return value.trim().replace(/[\\%_]/g, "\\$&"); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function sourceVersions(value: unknown): SpellDetail["sourceVersions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item)
    && typeof item.sourceId === "string" && typeof item.title === "string" && typeof item.revisionId === "string"
    ? [{ sourceId: item.sourceId, title: item.title, code: typeof item.code === "string" ? item.code : null,
      revision: typeof item.revision === "string" ? item.revision : null, revisionId: item.revisionId }]
    : []);
}
function firstSentence(value: string): string { return value.split(/(?<=[.!?])\s/u, 1)[0].slice(0, 240); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
