import type { QueryResultRow } from "pg";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import {
  buildRetrievalAuthorizationFilter,
  type RetrievalSelection,
  type RetrievalUser,
} from "../access/retrieval-filter.ts";
import { CursorCodec } from "./cursor.ts";
import { agentQuery } from "./database.ts";
import { invalidRequest, notFound } from "./errors.ts";

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

export type PageInput = Readonly<{ limit?: number; cursor?: string }>;
export type AgentSelection = RetrievalSelection & Readonly<{ entryType?: string }>;
export type AgentEntrySummary = Readonly<{
  id: string;
  entryId: string;
  revisionId: string;
  entryType: string;
  name: string;
  aliases: readonly unknown[];
  sourceId: string;
  fileId: string;
  edition: string;
  language: string;
}>;
export type AgentEntry = AgentEntrySummary & Readonly<{
  contentHash: string;
  typedFields: readonly unknown[];
  text: string;
  sections: readonly unknown[];
  citations: readonly unknown[];
  source: Readonly<Record<string, unknown>>;
}>;

type EntryRow = QueryResultRow & Readonly<{
  id: string;
  entry_id: string;
  revision_id: string;
  content_hash: string;
  entry_type: string;
  name: string;
  aliases: unknown[];
  typed_fields: unknown[];
  plain_text: string;
  canonical_payload: Record<string, unknown>;
  source_id: string;
  file_id: string;
  edition: string;
  language: string;
}>;

const database: Queryable = { query: agentQuery };
const MAX_LIMIT = 200;

/** Agent-facing reads over the indexed canonical model. Every operation applies application RBAC in SQL. */
export class AgentReadService {
  private readonly db: Queryable;
  private readonly cursors: CursorCodec;

  constructor(db: Queryable = database, cursors = CursorCodec.fromEnvironment()) {
    this.db = db;
    this.cursors = cursors;
  }

  async health(): Promise<void> {
    await this.db.query("SELECT 1");
  }

  async listEntityTypes(user: RetrievalUser, selection: RetrievalSelection = {}): Promise<{ entityTypes: readonly string[] }> {
    const boundary = accessibleEntries(user, selection);
    const result = await this.db.query<{ entry_type: string } & QueryResultRow>(
      `${boundary.sql} SELECT DISTINCT entry_type FROM accessible_entries ORDER BY entry_type`,
      boundary.params,
    );
    return { entityTypes: result.rows.map((row) => row.entry_type) };
  }

  async listEntries(user: RetrievalUser, input: PageInput & AgentSelection = {}): Promise<Page<AgentEntrySummary>> {
    const limit = pageLimit(input.limit);
    const entryType = input.entryType ? normalizedText(input.entryType, "entryType") : undefined;
    const binding = cursorBinding("entries", user, input, { entryType: entryType ?? null });
    const cursor = this.cursors.decode("entries", binding, input.cursor);
    const boundary = accessibleEntries(user, input);
    const params = [...boundary.params];
    const filters = ["1=1"];
    if (entryType) {
      params.push(entryType);
      filters.push(`entry_type = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.key, cursor.id);
      filters.push(`(entry_id, id) > ($${params.length - 1}, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const result = await this.db.query<EntryRow>(
      `${boundary.sql} SELECT * FROM accessible_entries
       WHERE ${filters.join(" AND ")} ORDER BY entry_id, id LIMIT $${params.length}`,
      params,
    );
    return makePage(result.rows, limit, this.cursors, binding);
  }

  async getEntry(user: RetrievalUser, identifier: string, selection: RetrievalSelection = {}): Promise<AgentEntry> {
    const row = await this.findEntry(user, identifier, selection, false);
    return mapEntry(row);
  }

  async resolveAlias(user: RetrievalUser, alias: string, selection: RetrievalSelection = {}): Promise<AgentEntry> {
    const row = await this.findEntry(user, alias, selection, true);
    return mapEntry(row);
  }

  async searchEntries(user: RetrievalUser, input: PageInput & AgentSelection & { query: string }): Promise<Page<AgentEntrySummary & {
    rank: number;
    snippet: string;
    citations: readonly unknown[];
    source: Readonly<Record<string, unknown>>;
  }>> {
    const search = normalizedText(input.query, "query", 500);
    const limit = pageLimit(input.limit);
    const entryType = input.entryType ? normalizedText(input.entryType, "entryType") : undefined;
    const binding = cursorBinding("search", user, input, { query: search, entryType: entryType ?? null });
    const cursor = this.cursors.decode("search", binding, input.cursor);
    const boundary = accessibleEntries(user, input);
    const params = [...boundary.params, search];
    const searchParam = params.length;
    const filters = [`document @@ plainto_tsquery('simple', $${searchParam})`];
    if (entryType) {
      params.push(entryType);
      filters.push(`entry_type = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.rank, cursor.key, cursor.id);
      filters.push(`(rank < $${params.length - 2} OR (rank = $${params.length - 2} AND (entry_id, id) > ($${params.length - 1}, $${params.length}::uuid)))`);
    }
    params.push(limit + 1);
    const result = await this.db.query<EntryRow & { rank: number; snippet: string }>(
      `${boundary.sql}, ranked AS (
         SELECT accessible_entries.*,
           to_tsvector('simple', name || ' ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(aliases)), ' ') || ' ' || plain_text) AS document
         FROM accessible_entries
       ), scored AS (
         SELECT ranked.*, ts_rank_cd(document, plainto_tsquery('simple', $${searchParam}))::float8 AS rank,
           ts_headline('simple', plain_text, plainto_tsquery('simple', $${searchParam}), 'MaxFragments=2, MaxWords=35') AS snippet
         FROM ranked
       ) SELECT * FROM scored WHERE ${filters.join(" AND ")}
       ORDER BY rank DESC, entry_id, id LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows;
    const items = rows.slice(0, limit).map((row) => ({
      ...mapSummary(row),
      rank: row.rank,
      snippet: row.snippet,
      citations: Array.isArray(row.canonical_payload.citations) ? row.canonical_payload.citations : [],
      source: isRecord(row.canonical_payload.source) ? row.canonical_payload.source : {},
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? this.cursors.encode("search", binding, { key: last.entryId, id: last.id, rank: last.rank }) : null,
    };
  }

  async getSource(user: RetrievalUser, sourceId: string, selection: RetrievalSelection = {}): Promise<Record<string, unknown>> {
    const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, selection));
    const params = [...access.params, normalizedText(sourceId, "sourceId")];
    const result = await this.db.query<QueryResultRow & {
      id: string; title: string; category: string; edition: string; language: string;
      publication_code: string | null; publication_title: string; publisher: string | null;
      release_year: number | null; publication_revision: string | null; attribution: string | null; license: string | null;
    }>(
      `SELECT s.id, s.title, s.category, s.edition, s.language, s.publication_code,
         s.publication_title, s.publisher, s.release_year, s.publication_revision, s.attribution, s.license
       FROM sources s WHERE ${access.sql} AND s.deleted_at IS NULL AND s.id::text = $${params.length} LIMIT 1`,
      params,
    );
    const source = result.rows[0];
    if (!source) throw notFound();
    return {
      id: source.id, title: source.title, category: source.category, edition: source.edition, language: source.language,
      publication: { code: source.publication_code, title: source.publication_title, publisher: source.publisher,
        releaseYear: source.release_year, revision: source.publication_revision, attribution: source.attribution },
      license: source.license,
    };
  }

  async getCitations(user: RetrievalUser, identifier: string, selection: RetrievalSelection = {}): Promise<{
    entryId: string; revisionId: string; sourceId: string; fileId: string; citations: readonly unknown[];
  }> {
    const entry = await this.getEntry(user, identifier, selection);
    return {
      entryId: entry.entryId,
      revisionId: entry.revisionId,
      sourceId: entry.sourceId,
      fileId: entry.fileId,
      citations: entry.citations,
    };
  }

  async readSection(user: RetrievalUser, identifier: string, sectionId: string, selection: RetrievalSelection = {}): Promise<Record<string, unknown>> {
    const entry = await this.getEntry(user, identifier, selection);
    const wanted = normalizedText(sectionId, "sectionId");
    const section = entry.sections.find((candidate) => isRecord(candidate) && candidate.sectionId === wanted);
    if (!section || !isRecord(section)) throw notFound();
    const start = typeof section.startOffset === "number" ? section.startOffset : 0;
    const end = typeof section.endOffset === "number" ? section.endOffset : entry.text.length;
    const citations = entry.citations.filter((candidate) => isRecord(candidate)
      && typeof candidate.startOffset === "number" && typeof candidate.endOffset === "number"
      && candidate.startOffset < end && candidate.endOffset > start);
    return {
      entryId: entry.entryId,
      revisionId: entry.revisionId,
      sourceId: entry.sourceId,
      fileId: entry.fileId,
      section,
      citations,
    };
  }

  async listChangedEntries(user: RetrievalUser, input: PageInput & RetrievalSelection & { since: string }): Promise<Page<Record<string, unknown>>> {
    const since = parseTimestamp(input.since);
    const limit = pageLimit(input.limit);
    const binding = cursorBinding("changes", user, input, { since });
    const cursor = this.cursors.decode("changes", binding, input.cursor);
    const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, input));
    const params = [...access.params, since];
    const sinceParam = params.length;
    const filters = [`greatest(indexed_at, coalesce(retired_at, '-infinity')) > $${sinceParam}::timestamptz`];
    if (cursor) {
      params.push(cursor.changedAt, cursor.key, cursor.id);
      filters.push(`(greatest(indexed_at, coalesce(retired_at, '-infinity')), entry_id, nie.id) > ($${params.length - 2}::timestamptz, $${params.length - 1}, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const result = await this.db.query<QueryResultRow & {
      id: string; entry_id: string; revision_id: string; lifecycle: string; indexed_at: Date | string; retired_at: Date | string | null;
    }>(
      `SELECT nie.id, nie.entry_id, nie.revision_id, nie.lifecycle, nie.indexed_at, nie.retired_at
       FROM nfs_index_entries nie JOIN sources s ON s.id = nie.source_id
       JOIN files f ON f.id = nie.file_id AND f.source_id = s.id
       WHERE ${access.sql} AND s.deleted_at IS NULL AND f.deleted_at IS NULL AND ${filters.join(" AND ")}
       ORDER BY greatest(indexed_at, coalesce(retired_at, '-infinity')), entry_id, nie.id
       LIMIT $${params.length}`,
      params,
    );
    const mapped = result.rows.map((row) => ({
      id: row.id, entryId: row.entry_id, revisionId: row.revision_id,
      change: row.lifecycle === "retired" ? "deleted" : "upserted",
      changedAt: new Date(row.retired_at ?? row.indexed_at).toISOString(),
    }));
    const items = mapped.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: result.rows.length > limit && last
        ? this.cursors.encode("changes", binding, { key: String(last.entryId), id: String(last.id), changedAt: String(last.changedAt) }) : null,
    };
  }

  private async findEntry(user: RetrievalUser, identifier: string, selection: RetrievalSelection, alias: boolean): Promise<EntryRow> {
    const value = normalizedText(identifier, alias ? "alias" : "identifier");
    const boundary = accessibleEntries(user, selection);
    const params = [...boundary.params, value];
    const predicate = alias
      ? `EXISTS (SELECT 1 FROM jsonb_array_elements_text(aliases) candidate WHERE lower(candidate) = lower($${params.length}))`
      : `(id::text = $${params.length} OR entry_id = $${params.length})`;
    const result = await this.db.query<EntryRow>(
      `${boundary.sql} SELECT * FROM accessible_entries WHERE ${predicate} ORDER BY entry_id LIMIT 1`,
      params,
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
}

type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;
function accessibleEntries(user: RetrievalUser, selection: RetrievalSelection): { sql: string; params: unknown[] } {
  const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, selection));
  return {
    params: [...access.params],
    sql: `WITH accessible_entries AS MATERIALIZED (
      SELECT nie.id, nie.entry_id, nie.revision_id, nie.content_hash, nie.entry_type, nie.name,
        nie.aliases, nie.typed_fields, nie.plain_text, nie.canonical_payload, nie.source_id, nie.file_id,
        s.edition, s.language
      FROM nfs_index_entries nie JOIN sources s ON s.id = nie.source_id
      JOIN files f ON f.id = nie.file_id AND f.source_id = s.id
      WHERE ${access.sql} AND s.deleted_at IS NULL AND f.deleted_at IS NULL AND nie.lifecycle = 'active'
    )`,
  };
}

function mapSummary(row: EntryRow): AgentEntrySummary {
  return { id: row.id, entryId: row.entry_id, revisionId: row.revision_id, entryType: row.entry_type,
    name: row.name, aliases: row.aliases, sourceId: row.source_id, fileId: row.file_id,
    edition: row.edition, language: row.language };
}

function mapEntry(row: EntryRow): AgentEntry {
  const payload = row.canonical_payload;
  const text = isRecord(payload.text) && typeof payload.text.plain === "string" ? payload.text.plain : row.plain_text;
  return { ...mapSummary(row), contentHash: row.content_hash, typedFields: row.typed_fields, text,
    sections: isRecord(payload.text) && Array.isArray(payload.text.sections) ? payload.text.sections : [],
    citations: Array.isArray(payload.citations) ? payload.citations : [],
    source: isRecord(payload.source) ? payload.source : {} };
}

function makePage(rows: readonly EntryRow[], limit: number, cursors: CursorCodec,
  binding: Readonly<Record<string, unknown>>): Page<AgentEntrySummary> {
  const selected = rows.slice(0, limit);
  return { items: selected.map(mapSummary), nextCursor: rows.length > limit && selected.length
    ? cursors.encode("entries", binding, { key: selected[selected.length - 1].entry_id, id: selected[selected.length - 1].id }) : null };
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw invalidRequest(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  return value;
}

function normalizedText(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.normalize("NFC").trim() || value.length > max) throw invalidRequest(`${name} is invalid.`);
  return value.normalize("NFC").trim();
}

function parseTimestamp(value: string): string {
  const normalized = normalizedText(value, "since");
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf())) throw invalidRequest("since must be an ISO 8601 timestamp.");
  return date.toISOString();
}

function cursorBinding(kind: string, user: RetrievalUser, selection: RetrievalSelection,
  operationFilters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    kind,
    role: user.role,
    userId: user.userId ?? null,
    edition: selection.edition ?? null,
    language: selection.language ?? null,
    category: selection.category ?? null,
    ...operationFilters,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
