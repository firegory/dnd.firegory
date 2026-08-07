import type { QueryResultRow } from "pg";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import { buildRetrievalAuthorizationFilter, type RetrievalSelection, type RetrievalUser } from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { flatProjectionFromTypedFields, type FlatEntryType, type FlatProjection } from "./flat-schema.ts";

type Queryable = Readonly<{ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }> }>;
export type FlatListOptions = Omit<RetrievalSelection, "category"> & Readonly<{
  sourceCategory?: RetrievalSelection["category"];
  query?: string; entryCategory?: string; rarity?: string; attunement?: boolean; repeatable?: boolean;
  ability?: string; skill?: string; related?: string;
  minLevel?: number; maxLevel?: number; minCost?: number; maxCost?: number; minWeight?: number; maxWeight?: number;
  cursor?: string; limit?: number;
}>;
export type FlatCitation = Readonly<{ id: string; quote: string; section: string; page: number | null; sourceId: string; fileId: string; previewUrl: string | null; sourceUrl: string | null; sourceDetailUrl: string; fieldPath: string | null }>;
export type FlatRelation = Readonly<{ type: string; direction: "incoming" | "outgoing"; entryId: string; entryType: string; title: string }>;
export type FlatListEntry = Readonly<{
  id: string; revisionId: string; entryType: FlatEntryType; title: string; aliases: readonly string[]; summary: string;
  edition: string; language: string; source: Readonly<{ id: string; title: string; code: string | null; revision: string | null }>;
  projection: FlatProjection;
}>;
export type FlatDetail = FlatListEntry & Readonly<{
  body: string; citations: readonly FlatCitation[]; relations: readonly FlatRelation[];
  sourceVersions: readonly Readonly<{ sourceId: string; title: string; code: string | null; revision: string | null; revisionId: string }>[];
  sourceVersion: Readonly<{ url: string; fingerprintSha256: string; rawBlobPath: string; fetchedAt: string; fileChecksumSha256: string; index: Readonly<{ url: string; fingerprintSha256: string; rawBlobPath: string; fetchedAt: string; cardFingerprintSha256: string }> }> | null;
}>;
export class FlatReadInputError extends Error {}
export class FlatNotFoundError extends Error {}

type FlatRow = QueryResultRow & Readonly<{
  entry_id: string; revision_id: string; entry_type: FlatEntryType; name: string; aliases: unknown; typed_fields: unknown;
  plain_text: string; canonical_payload: Record<string, unknown>; source_id: string; file_id: string; mime_type: string;
  source_title: string; edition: string; language: string; publication_code: string | null; publication_revision: string | null;
  sort_title: string; source_versions: unknown; relations: unknown;
}>;
const database: Queryable = { query };
const STABLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export class FlatReadService {
  private readonly db: Queryable;
  constructor(db: Queryable = database) { this.db = db; }

  async list(user: RetrievalUser, type: FlatEntryType, options: FlatListOptions = {}): Promise<Readonly<{ entries: readonly FlatListEntry[]; count: number; nextCursor: string | null }>> {
    validateOptions(options);
    const boundary = boundarySql(user, type, options);
    const filters = flatFilters(boundary.params, options);
    const limit = options.limit ?? 24;
    boundary.params.push(limit + 1);
    const result = await this.db.query<FlatRow>(`${boundary.sql} SELECT * FROM accessible_flat flat WHERE ${filters} ORDER BY flat.sort_title COLLATE "C", flat.entry_id LIMIT $${boundary.params.length}`, boundary.params);
    const visible = result.rows.slice(0, limit);
    const countOptions = { ...options }; delete countOptions.cursor; delete countOptions.limit;
    const count = await this.count(user, type, countOptions);
    const last = visible.at(-1);
    return { entries: visible.map(mapListEntry), count, nextCursor: result.rows.length > limit && last ? encodeCursor(last.sort_title, last.entry_id) : null };
  }

  async count(user: RetrievalUser, type: FlatEntryType, options: Omit<FlatListOptions, "cursor" | "limit"> = {}): Promise<number> {
    validateOptions(options);
    const boundary = boundarySql(user, type, options);
    const result = await this.db.query<{ count: string } & QueryResultRow>(`${boundary.sql} SELECT count(*)::text AS count FROM accessible_flat flat WHERE ${flatFilters(boundary.params, options)}`, boundary.params);
    return Number(result.rows[0]?.count ?? 0);
  }

  async get(user: RetrievalUser, type: FlatEntryType, identifier: string, selection: RetrievalSelection = {}): Promise<FlatDetail> {
    const normalized = normalizeIdentifier(identifier);
    const boundary = boundarySql(user, type, selection);
    boundary.params.push(normalized);
    const result = await this.db.query<FlatRow>(`${boundary.sql}
      SELECT flat.*, coalesce((
        SELECT jsonb_agg(jsonb_build_object('type', relation.relation_type, 'direction', relation.direction,
          'entryId', target.entry_id, 'entryType', target.entry_type, 'title', target.name)
          ORDER BY target.name, target.entry_id)
        FROM (
          SELECT rel.relation_type, rel.target_entry_id AS target_id, 'outgoing' AS direction
          FROM compendium_entry_relations rel JOIN compendium_entries owner ON owner.id = rel.source_entry_id
          WHERE owner.entry_type = flat.entry_type::compendium_entry_type
            AND owner.canonical_key = regexp_replace(flat.entry_id, '^[^-]+-', '')
            AND EXISTS (SELECT 1 FROM compendium_import_links evidence WHERE evidence.relation_id = rel.id)
          UNION ALL
          SELECT rel.relation_type, rel.source_entry_id AS target_id, 'incoming' AS direction
          FROM compendium_entry_relations rel JOIN compendium_entries owner ON owner.id = rel.target_entry_id
          WHERE owner.entry_type = flat.entry_type::compendium_entry_type
            AND owner.canonical_key = regexp_replace(flat.entry_id, '^[^-]+-', '')
            AND EXISTS (SELECT 1 FROM compendium_import_links evidence WHERE evidence.relation_id = rel.id)
        ) relation
        JOIN compendium_entries target_entry ON target_entry.id = relation.target_id
        JOIN accessible_flat_versions target ON target.entry_id = target_entry.entry_type::text || '-' || target_entry.canonical_key
          AND target.source_rank = 1 AND target.language = flat.language
      ), '[]'::jsonb) AS relations
      FROM accessible_flat flat
      WHERE flat.entry_id = $${boundary.params.length} OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(flat.aliases) alias
        WHERE compendium_normalize_name(alias) = compendium_normalize_name($${boundary.params.length})
      ) ORDER BY flat.source_priority DESC, flat.revision_id LIMIT 1`, boundary.params);
    if (!result.rows[0]) throw new FlatNotFoundError();
    return mapDetail(result.rows[0]);
  }
}

function boundarySql(user: RetrievalUser, type: FlatEntryType, selection: RetrievalSelection | FlatListOptions): { sql: string; params: unknown[] } {
  const sourceSelection: RetrievalSelection = { ...selection, category: "sourceCategory" in selection ? selection.sourceCategory : "category" in selection ? selection.category : undefined };
  const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, sourceSelection));
  const params: unknown[] = [...access.params, type];
  return { params, sql: `WITH accessible_flat_versions AS MATERIALIZED (
    SELECT n.entry_id, n.revision_id, n.entry_type, n.name, n.aliases, n.typed_fields, n.plain_text, n.canonical_payload,
      n.source_id, n.file_id, f.mime_type, s.title AS source_title, s.edition, s.language, s.publication_code,
      s.publication_revision, s.source_priority, lower(n.name) AS sort_title,
      row_number() OVER (PARTITION BY n.entry_id ORDER BY s.source_priority DESC, n.indexed_at DESC, n.revision_id) AS source_rank,
      (SELECT jsonb_object_agg(field->>'key', field->'value') FROM jsonb_array_elements(n.typed_fields) field) AS attributes
    FROM nfs_index_entries n JOIN sources s ON s.id = n.source_id JOIN files f ON f.id = n.file_id AND f.source_id = s.id
    WHERE ${access.sql} AND s.deleted_at IS NULL AND f.deleted_at IS NULL AND n.lifecycle = 'active' AND n.entry_type = $${params.length}
  ), accessible_flat AS MATERIALIZED (
    SELECT flat_version.*, (SELECT jsonb_agg(jsonb_build_object('sourceId', version.source_id, 'title', version.source_title,
      'code', version.publication_code, 'revision', version.publication_revision, 'revisionId', version.revision_id)
      ORDER BY version.source_priority DESC, version.revision_id) FROM accessible_flat_versions version
      WHERE version.entry_id = flat_version.entry_id) AS source_versions
    FROM accessible_flat_versions flat_version WHERE flat_version.source_rank = 1
  )` };
}

function flatFilters(params: unknown[], options: FlatListOptions | Omit<FlatListOptions, "cursor" | "limit">): string {
  const filters = ["1=1"];
  const textFilter = (key: string, value: string | undefined) => { if (value) filters.push(`flat.attributes->>'${key}' ILIKE $${params.push(`%${escapeLike(value)}%`)} ESCAPE '\\'`); };
  textFilter("category", options.entryCategory); textFilter("rarity", options.rarity); textFilter("ability-scores", options.ability); textFilter("skill-proficiencies", options.skill);
  if (options.attunement !== undefined) filters.push(`(flat.attributes->>'requires-attunement')::boolean = $${params.push(options.attunement)}`);
  if (options.repeatable !== undefined) filters.push(`(flat.attributes->>'repeatable')::boolean = $${params.push(options.repeatable)}`);
  for (const [key, value, operator] of [["prerequisite-level", options.minLevel, ">="], ["prerequisite-level", options.maxLevel, "<="], ["cost-cp", options.minCost, ">="], ["cost-cp", options.maxCost, "<="], ["weight-lb", options.minWeight, ">="], ["weight-lb", options.maxWeight, "<="]] as const) {
    if (value !== undefined) filters.push(`(flat.attributes->>'${key}')::numeric ${operator} $${params.push(value)}`);
  }
  if (options.related) filters.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(flat.attributes->'related-terms', '[]'::jsonb)) term WHERE term ILIKE $${params.push(`%${escapeLike(options.related)}%`)} ESCAPE '\\')`);
  if (options.query) filters.push(`(flat.name ILIKE $${params.push(`%${escapeLike(options.query)}%`)} ESCAPE '\\' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(flat.aliases) alias WHERE alias ILIKE $${params.length} ESCAPE '\\'))`);
  if ("cursor" in options && options.cursor) { const cursor = decodeCursor(options.cursor); params.push(cursor.title, cursor.id); filters.push(`(flat.sort_title COLLATE "C", flat.entry_id) > ($${params.length - 1} COLLATE "C", $${params.length})`); }
  return filters.join(" AND ");
}

function validateOptions(options: FlatListOptions | Omit<FlatListOptions, "cursor" | "limit">): void {
  for (const [name, value] of [["query", options.query], ["category", options.entryCategory], ["rarity", options.rarity], ["ability", options.ability], ["skill", options.skill], ["related", options.related]] as const) if (value !== undefined && (!value.trim() || value.length > 120)) throw new FlatReadInputError(`Invalid ${name} filter.`);
  for (const value of [options.minLevel, options.maxLevel, options.minCost, options.maxCost, options.minWeight, options.maxWeight]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new FlatReadInputError("Numeric filters must be nonnegative.");
  if (options.minLevel !== undefined && !Number.isSafeInteger(options.minLevel) || options.maxLevel !== undefined && !Number.isSafeInteger(options.maxLevel)) throw new FlatReadInputError("Level filters must be integers.");
  if ("limit" in options && options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new FlatReadInputError("limit must be from 1 to 100.");
  if ("cursor" in options && options.cursor) decodeCursor(options.cursor);
}

function mapListEntry(row: FlatRow): FlatListEntry { return { id: row.entry_id, revisionId: row.revision_id, entryType: row.entry_type, title: row.name, aliases: strings(row.aliases), summary: firstSentence(row.plain_text), edition: row.edition, language: row.language, source: { id: row.source_id, title: row.source_title, code: row.publication_code, revision: row.publication_revision }, projection: flatProjectionFromTypedFields(row.entry_type, row.typed_fields) }; }
function mapDetail(row: FlatRow): FlatDetail {
  const base = mapListEntry(row); const payload = row.canonical_payload;
  const citations = Array.isArray(payload.citations) ? payload.citations.flatMap((value, index) => {
    if (!isRecord(value) || (value.page !== null && !Number.isSafeInteger(value.page)) || typeof value.quote !== "string") return [];
    const page = value.page === null ? null : Number(value.page); const sourceUrl = typeof value.sourceUrl === "string" && /^https:\/\//.test(value.sourceUrl) ? value.sourceUrl : null;
    return [{ id: typeof value.citationId === "string" ? value.citationId : `citation-${index + 1}`, quote: value.quote, section: typeof value.section === "string" ? value.section : base.title, page, sourceId: row.source_id, fileId: row.file_id, previewUrl: row.mime_type === "application/pdf" && page !== null ? `/api/citations/preview?sourceId=${encodeURIComponent(row.source_id)}&fileId=${encodeURIComponent(row.file_id)}&page=${page}` : null, sourceUrl, sourceDetailUrl: `/api/sources/${encodeURIComponent(row.source_id)}`, fieldPath: typeof value.fieldPath === "string" ? value.fieldPath : null }];
  }) : [];
  return { ...base, body: row.plain_text, citations, relations: relations(row.relations), sourceVersions: sourceVersions(row.source_versions), sourceVersion: sourceVersion(payload.sourceVersion) };
}
function relations(value: unknown): FlatRelation[] { return Array.isArray(value) ? value.flatMap((item) => isRecord(item) && typeof item.type === "string" && (item.direction === "incoming" || item.direction === "outgoing") && typeof item.entryId === "string" && typeof item.entryType === "string" && typeof item.title === "string" ? [{ type: item.type, direction: item.direction, entryId: item.entryId, entryType: item.entryType, title: item.title }] : []) : []; }
function sourceVersions(value: unknown): FlatDetail["sourceVersions"] { return Array.isArray(value) ? value.flatMap((item) => isRecord(item) && typeof item.sourceId === "string" && typeof item.title === "string" && typeof item.revisionId === "string" ? [{ sourceId: item.sourceId, title: item.title, code: typeof item.code === "string" ? item.code : null, revision: typeof item.revision === "string" ? item.revision : null, revisionId: item.revisionId }] : []) : []; }
function sourceVersion(value: unknown): FlatDetail["sourceVersion"] { if (!isRecord(value) || typeof value.url !== "string" || typeof value.fingerprintSha256 !== "string" || typeof value.rawBlobPath !== "string" || typeof value.fetchedAt !== "string" || typeof value.fileChecksumSha256 !== "string" || !isRecord(value.index) || typeof value.index.url !== "string" || typeof value.index.fingerprintSha256 !== "string" || typeof value.index.rawBlobPath !== "string" || typeof value.index.fetchedAt !== "string" || typeof value.index.cardFingerprintSha256 !== "string") return null; return { url: value.url, fingerprintSha256: value.fingerprintSha256, rawBlobPath: value.rawBlobPath, fetchedAt: value.fetchedAt, fileChecksumSha256: value.fileChecksumSha256, index: { url: value.index.url, fingerprintSha256: value.index.fingerprintSha256, rawBlobPath: value.index.rawBlobPath, fetchedAt: value.index.fetchedAt, cardFingerprintSha256: value.index.cardFingerprintSha256 } }; }
function encodeCursor(title: string, id: string): string { return Buffer.from(JSON.stringify({ v: 1, title, id }), "utf8").toString("base64url"); }
function decodeCursor(value: string): { title: string; id: string } { try { if (value.length > 512) throw new Error(); const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!isRecord(decoded) || decoded.v !== 1 || typeof decoded.title !== "string" || typeof decoded.id !== "string" || !STABLE_ID.test(decoded.id)) throw new Error(); return { title: decoded.title, id: decoded.id }; } catch { throw new FlatReadInputError("Invalid flat entry cursor."); } }
function normalizeIdentifier(value: string): string { const normalized = typeof value === "string" ? value.normalize("NFC").trim() : ""; if (!normalized || normalized.length > 256) throw new FlatNotFoundError(); return normalized; }
function escapeLike(value: string): string { return value.trim().replace(/[\\%_]/g, "\\$&"); }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function firstSentence(value: string): string { return value.split(/(?<=[.!?])\s/u, 1)[0].slice(0, 240); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
