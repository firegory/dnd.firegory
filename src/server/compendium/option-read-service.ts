import type { QueryResultRow } from "pg";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import { buildRetrievalAuthorizationFilter, type RetrievalSelection, type RetrievalUser } from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { classProjectionFromTypedFields, speciesProjectionFromTypedFields, type ClassProjection, type SpeciesProjection } from "./hierarchy-schema.ts";
import { CompendiumNotFoundError, CompendiumReadInputError } from "./read-service.ts";

type Queryable = Readonly<{ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }> }>;
export type OptionType = "class" | "species";
export type OptionListOptions = RetrievalSelection & Readonly<{ kind?: "class" | "subclass" | "species" | "variant"; query?: string; limit?: number }>;
export type OptionVersionSelection = RetrievalSelection & Readonly<{ sourceId?: string; revisionId?: string }>;
export type OptionCitation = Readonly<{ id: string; quote: string; section: string; page: number | null; fieldPath: string | null; previewUrl: string | null; sourceUrl: string | null; sourceDetailUrl: string }>;
export type OptionResolvedRelation = Readonly<{ targetId:string; targetRevisionId:string; targetSourceId:string; relationKind:"parent"|"feature"|"cross_link"|"trait_override"; targetKind:string; sourceAnchor:string; anchor:string|null }>;
type Common = Readonly<{ id: string; revisionId: string; title: string; aliases: readonly string[]; summary: string; edition: string; language: string; source: Readonly<{ id: string; title: string; code: string | null; revision: string | null }> }>;
export type ClassListEntry = Common & ClassProjection;
export type SpeciesListEntry = Common & SpeciesProjection;
export type OptionListEntry = ClassListEntry | SpeciesListEntry;
export type OptionDetail = OptionListEntry & Readonly<{ body: string; citations: readonly OptionCitation[]; accessibleCrossLinks: readonly string[]; relations:readonly OptionResolvedRelation[]; sourceVersions: readonly Readonly<{ sourceId: string; title: string; code: string | null; revision: string | null; revisionId: string }>[] }>;

type Row = QueryResultRow & Record<string, unknown> & { entry_id: string; revision_id: string; name: string; typed_fields: unknown; aliases: unknown; plain_text: string; canonical_payload: Record<string, unknown>; source_id: string; file_id: string; mime_type: string; source_title: string; edition: string; language: string; publication_code: string | null; publication_revision: string | null; source_versions: unknown; relations: unknown };
const database: Queryable = { query };

export class OptionReadService {
  private readonly db: Queryable;
  constructor(db: Queryable = database) { this.db = db; }

  async list(type: OptionType, user: RetrievalUser, options: OptionListOptions = {}): Promise<{ options: readonly OptionListEntry[]; count: number }> {
    validate(type, options); const boundary = boundarySql(type, user, options); const filters = optionFilters(boundary.params, options);
    boundary.params.push(options.limit ?? 100);
    const result = await this.db.query<Row>(`${boundary.sql} SELECT * FROM selected_options option WHERE ${filters} ORDER BY option.sort_title COLLATE "C",option.entry_id LIMIT $${boundary.params.length}`, boundary.params);
    const countBoundary = boundarySql(type, user, options); const countFilters = optionFilters(countBoundary.params, options);
    const count = await this.db.query<{ count: string } & QueryResultRow>(`${countBoundary.sql} SELECT count(*)::text AS count FROM selected_options option WHERE ${countFilters}`, countBoundary.params);
    return { options: result.rows.map((row) => mapList(type, row)), count: Number(count.rows[0]?.count ?? 0) };
  }

  async get(type: OptionType, user: RetrievalUser, identifier: string, selection: OptionVersionSelection = {}): Promise<OptionDetail> {
    const normalized = identifier.normalize("NFC").trim(); if (!normalized || normalized.length > 256) throw new CompendiumNotFoundError();
    if (selection.sourceId && !UUID.test(selection.sourceId)) throw new CompendiumReadInputError("Invalid sourceId.");
    if (selection.revisionId && !/^rev-[0-9a-f]{64}$/.test(selection.revisionId)) throw new CompendiumReadInputError("Invalid revisionId.");
    const boundary = boundarySql(type, user, selection); boundary.params.push(normalized);
    const result = await this.db.query<Row>(`${boundary.sql} SELECT * FROM selected_options option WHERE option.entry_id=$${boundary.params.length}
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(option.aliases) alias WHERE compendium_normalize_name(alias)=compendium_normalize_name($${boundary.params.length}))
      ORDER BY option.source_priority DESC,option.revision_id LIMIT 1`, boundary.params);
    if (!result.rows[0]) throw new CompendiumNotFoundError(); return mapDetail(type, result.rows[0]);
  }
}

function boundarySql(type: OptionType, user: RetrievalUser, selection: OptionVersionSelection): { sql: string; params: unknown[] } {
  const access = buildSourceAccessSql(buildRetrievalAuthorizationFilter(user, selection));
  const exact=[] as string[];
  if(selection.sourceId)exact.push(`option_version.source_id=$${access.params.push(selection.sourceId)}`);
  if(selection.revisionId)exact.push(`option_version.revision_id=$${access.params.push(selection.revisionId)}`);
  if(exact.length===0)exact.push("option_version.source_rank=1");
  const typePredicate = type === "class" ? "n.entry_type='classFeature' AND n.entry_id LIKE 'class-%' AND n.attributes ? 'hit-die'" : "n.entry_type='other' AND n.entry_id LIKE 'species-%' AND n.attributes ? 'size' AND n.attributes ? 'speed'";
  return { params: [...access.params], sql: `WITH accessible_entries AS MATERIALIZED (
    SELECT n.*,s.title AS source_title,s.publication_code,s.publication_revision,s.source_priority,f.mime_type,
      lower(n.name) AS sort_title,fields.attributes,row_number() OVER (PARTITION BY n.entry_id ORDER BY s.source_priority DESC,n.indexed_at DESC,n.revision_id) AS source_rank
    FROM nfs_index_entries n JOIN sources s ON s.id=n.source_id JOIN files f ON f.id=n.file_id AND f.source_id=s.id
    CROSS JOIN LATERAL (SELECT coalesce(jsonb_object_agg(field->>'key',field->'value'),'{}') AS attributes FROM jsonb_array_elements(n.typed_fields) field) fields
    WHERE ${access.sql} AND s.deleted_at IS NULL AND f.deleted_at IS NULL AND n.lifecycle='active'
  ), option_versions AS MATERIALIZED (SELECT n.*,${kindSql(type, "n.attributes")} AS option_kind FROM accessible_entries n WHERE ${typePredicate}),
  selected_options AS MATERIALIZED (SELECT option_version.*,
    (SELECT jsonb_agg(jsonb_build_object('targetId',target.entry_id,'targetRevisionId',target.revision_id,
      'targetSourceId',target.source_id,'relationKind',relation.relation_kind,'targetKind',relation.target_kind,
      'sourceAnchor',relation.source_anchor,'anchor',relation.anchor)
      ORDER BY relation.relation_kind,relation.position)
     FROM nfs_index_option_relations relation JOIN accessible_entries target
       ON target.repository_id=relation.repository_id AND target.entry_id=relation.target_entry_id
      AND target.revision_id=relation.target_revision_id AND target.source_id=relation.target_source_id
      AND target.file_id=relation.target_file_id AND target.lifecycle='active'
     WHERE relation.repository_id=option_version.repository_id AND relation.source_entry_id=option_version.entry_id
       AND relation.source_revision_id=option_version.revision_id AND relation.source_id=option_version.source_id
       AND relation.source_file_id=option_version.file_id
       AND relation.edition=option_version.edition AND relation.language=option_version.language
       AND relation.target_lifecycle='active') AS relations,
    (SELECT jsonb_agg(jsonb_build_object('sourceId',v.source_id,'title',v.source_title,'code',v.publication_code,'revision',v.publication_revision,'revisionId',v.revision_id) ORDER BY v.source_priority DESC,v.revision_id) FROM option_versions v WHERE v.entry_id=option_version.entry_id) AS source_versions
    FROM option_versions option_version WHERE ${exact.join(" AND ")})` };
}

function optionFilters(params: unknown[], options: OptionListOptions): string {
  const filters = ["1=1"];
  if (options.kind) filters.push(`option.option_kind=$${params.push(options.kind)}`);
  if (options.query) filters.push(`(option.name ILIKE $${params.push(`%${options.query.trim().replace(/[\\%_]/g,"\\$&")}%`)} ESCAPE '\\' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(option.aliases) alias WHERE alias ILIKE $${params.length} ESCAPE '\\'))`);
  return filters.join(" AND ");
}
function kindSql(type: OptionType, attributes: string): string {
  if (type === "class") return `coalesce(${attributes}->>'kind','class')`;
  return `CASE WHEN ${attributes} ? 'kind' THEN ${attributes}->>'kind' WHEN jsonb_typeof(${attributes}->'parent-species-ids')='array' AND jsonb_array_length(${attributes}->'parent-species-ids')>0 THEN 'variant' ELSE 'species' END`;
}
function validate(type: OptionType, options: OptionListOptions): void {
  if (options.query !== undefined && (!options.query.trim() || options.query.length > 120)) throw new CompendiumReadInputError("Invalid option query.");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new CompendiumReadInputError("limit must be from 1 to 100.");
  if (options.kind && !(type === "class" ? ["class","subclass"] : ["species","variant"]).includes(options.kind)) throw new CompendiumReadInputError("Invalid option kind.");
}
function mapList(type: OptionType, row: Row): OptionListEntry {
  const common = { id: String(row.entry_id), revisionId: String(row.revision_id), title: String(row.name), aliases: strings(row.aliases), summary: firstSentence(String(row.plain_text)), edition: String(row.edition), language: String(row.language), source: { id: String(row.source_id), title: String(row.source_title), code: row.publication_code == null ? null : String(row.publication_code), revision: row.publication_revision == null ? null : String(row.publication_revision) } };
  const relations=resolvedRelations(row.relations);const targets=(kind:OptionResolvedRelation["relationKind"])=>new Set(relations.filter((relation)=>relation.relationKind===kind).map((relation)=>relation.targetId));
  if(type==="class"){const projection=classProjectionFromTypedFields(row.typed_fields);return{...common,...projection,parentClassIds:projection.parentClassIds.filter((id)=>targets("parent").has(id)),features:projection.features.filter((feature)=>targets("feature").has(feature.canonicalId)),crossLinks:projection.crossLinks.filter((id)=>targets("cross_link").has(id))};}
  const projection=speciesProjectionFromTypedFields(row.typed_fields);return{...common,...projection,parentSpeciesIds:projection.parentSpeciesIds.filter((id)=>targets("parent").has(id)),crossLinks:projection.crossLinks.filter((id)=>targets("cross_link").has(id))};
}
function mapDetail(type: OptionType, row: Row): OptionDetail {
  const base = mapList(type, row); const payload = row.canonical_payload; const relations=resolvedRelations(row.relations);
  const citations = Array.isArray(payload.citations) ? payload.citations.flatMap((item, index) => {
    if (!record(item) || typeof item.quote !== "string") return []; const page = Number.isSafeInteger(item.page) ? Number(item.page) : null;
    return [{ id: typeof item.citationId === "string" ? item.citationId : `citation-${index+1}`, quote: item.quote, section: typeof item.section === "string" ? item.section : base.title, page,
      fieldPath: typeof item.fieldPath === "string" ? item.fieldPath : null, previewUrl: row.mime_type === "application/pdf" && page ? `/api/citations/preview?sourceId=${encodeURIComponent(String(row.source_id))}&fileId=${encodeURIComponent(String(row.file_id))}&page=${page}` : null,
      sourceUrl: typeof item.sourceUrl === "string" && item.sourceUrl.startsWith("https://") ? item.sourceUrl : null, sourceDetailUrl: `/api/sources/${encodeURIComponent(String(row.source_id))}` }];
  }) : [];
  return { ...base, body: String(row.plain_text), citations, accessibleCrossLinks: base.crossLinks, relations, sourceVersions: sourceVersions(row.source_versions) };
}
function resolvedRelations(value:unknown):OptionResolvedRelation[]{return Array.isArray(value)?value.flatMap((item)=>record(item)&&typeof item.targetId==="string"&&typeof item.targetRevisionId==="string"&&typeof item.targetSourceId==="string"&&["parent","feature","cross_link","trait_override"].includes(String(item.relationKind))?[{targetId:item.targetId,targetRevisionId:item.targetRevisionId,targetSourceId:item.targetSourceId,relationKind:String(item.relationKind) as OptionResolvedRelation["relationKind"],targetKind:typeof item.targetKind==="string"?item.targetKind:"other",sourceAnchor:typeof item.sourceAnchor==="string"?item.sourceAnchor:"",anchor:typeof item.anchor==="string"?item.anchor:null}]:[]):[];}
function sourceVersions(value: unknown): OptionDetail["sourceVersions"] { return Array.isArray(value) ? value.flatMap((item) => record(item) && typeof item.sourceId === "string" && typeof item.title === "string" && typeof item.revisionId === "string" ? [{ sourceId:item.sourceId,title:item.title,code:typeof item.code==="string"?item.code:null,revision:typeof item.revision==="string"?item.revision:null,revisionId:item.revisionId }] : []) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function firstSentence(value: string): string { return value.split(/(?<=[.!?])\s/u,1)[0].slice(0,240); }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
