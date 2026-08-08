import type { QueryResultRow } from "pg";

import { assertAdminContext, type AdminContext } from "../admin/admin-context.ts";
import { PublicationEnqueueAmbiguousError, submitPublicationCommand, submitUnpublicationCommand } from "../content-storage/publication-command.ts";
import { createCanonicalRevision, getDataRoot, type CanonicalRevision, type JsonValue } from "../content-storage/repository.ts";
import { assertCanonicalRevision, assertDeletionContractSupported, ContentIntegrityError, ContentSchemaValidationError, loadResolvedRepositoryManifest } from "../content-storage/validation.ts";
import { contentSourceFilesFromMetadataRecords, contentSourceFromMetadataRecord } from "../content/source-projection.ts";
import { ContentMetadataNotFoundError, ContentMetadataService, ContentMetadataValidationError } from "../content/metadata.ts";
import { withTransaction } from "../db/client.ts";
import { blocksToBody, editorExtension, parseEditorCorrectionInput, parseEditorEntryInput } from "./entry-editor-model.ts";
import { CompendiumService, type CompendiumEntryType } from "./service.ts";
import { hierarchyTypedValue, validateClassProjection, validateSpeciesProjection, HierarchyValidationError } from "./hierarchy-schema.ts";
import { canonicalEntryId } from "./identity.ts";

type DbClient = Readonly<{ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> }>;
type TransactionRunner = <T>(callback: (client: DbClient) => Promise<T>) => Promise<T>;
type Submitters = Readonly<{ publish: typeof submitPublicationCommand; unpublish: typeof submitUnpublicationCommand }>;

export class EntryEditorError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "EntryEditorError"; this.status = status; }
}

export type EditorRevision = Readonly<{
  id: string; number: number; title: string; summary: string | null; body: string; blocks: readonly unknown[];
  projection: Record<string, unknown>; citations: readonly Record<string, unknown>[]; basedOnRevisionId: string | null;
  actor: string | null; reason: string | null; createdAt: string; lifecycle: string;
}>;
export type EditorPublication = Readonly<{ id: string; revisionId: string | null; action: "publish" | "unpublish"; status: string; canonicalRevisionId: string | null; actor: string; reason: string; lastError: string | null; createdAt: string; completedAt: string | null }>;
export type EditorAuditEvent = Readonly<{ id: string; revisionId: string | null; eventType: string; actor: string; reason: string; details: Record<string, unknown>; createdAt: string }>;
export type EditorEntry = Readonly<{
  versionId: string; entryId: string; canonicalKey: string; entryType: CompendiumEntryType; edition: string; language: string;
  sourceId: string; fileId: string; slug: string; aliases: readonly string[]; activeRevisionId: string; editorHeadRevisionId: string; versionLifecycle: string;
  canonicalRevisionId: string | null; publicationStatus: string; publicationAction: string | null;
  revisions: readonly EditorRevision[]; publications: readonly EditorPublication[]; audit: readonly EditorAuditEvent[];
}>;
export type EditorEvidenceBoundary = Readonly<{ sourceId: string; sourceTitle: string; edition: string; language: string; fileId: string; fileName: string }>;
export type EditorEvidenceChunk = Readonly<{ id: string; generationId: string; quote: string; page: number | null; section: string | null }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPE_TABLE: Record<CompendiumEntryType, string> = { spell: "spells", creature: "creatures", item: "items", class: "classes", feature: "features", species: "species", background: "backgrounds", feat: "feats", equipment: "equipment", glossary: "glossary" };

export class EntryEditorService {
  private readonly transaction: TransactionRunner;
  private readonly compendium: CompendiumService;
  private readonly submitters: Submitters;
  private readonly activeCanonical: typeof defaultActiveCanonical;

  constructor(
    transaction: TransactionRunner = withTransaction as TransactionRunner,
    compendium = new CompendiumService(transaction),
    submitters: Submitters = { publish: submitPublicationCommand, unpublish: submitUnpublicationCommand },
    activeCanonical: typeof defaultActiveCanonical = defaultActiveCanonical,
  ) { this.transaction=transaction; this.compendium=compendium; this.submitters=submitters; this.activeCanonical=activeCanonical; }

  async list(admin: AdminContext): Promise<readonly Omit<EditorEntry, "revisions" | "publications" | "audit">[]> {
    assertAdminContext(admin);
    return this.transaction(async (client) => {
      const result = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT v.id AS version_id, v.entry_id, e.canonical_key, v.entry_type, v.edition, v.language, v.lifecycle AS version_lifecycle,
        v.source_id, v.file_id, v.active_revision_id, v.editor_head_revision_id, n.name AS slug,
        coalesce(array_agg(a.name ORDER BY a.name) FILTER (WHERE a.name IS NOT NULL), '{}') AS aliases,
         p.canonical_revision_id, coalesce(p.status::text, 'unpublished') AS publication_status, p.action AS publication_action
        FROM compendium_versions v JOIN compendium_entries e ON e.id=v.entry_id
        JOIN compendium_names n ON n.version_id=v.id AND n.kind='slug'
        LEFT JOIN compendium_names a ON a.version_id=v.id AND a.kind='alias'
        LEFT JOIN LATERAL (SELECT status, action, canonical_revision_id FROM compendium_editor_publications WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
        GROUP BY v.id,e.canonical_key,n.name,p.status,p.action,p.canonical_revision_id ORDER BY e.canonical_key,v.language`);
      return result.rows.map(mapEntrySummary);
    });
  }

  async get(admin: AdminContext, versionId: string): Promise<EditorEntry> {
    assertAdminContext(admin); requireUuid(versionId, "versionId");
    const [entry, canonicalRevisionId] = await Promise.all([
      this.transaction((client) => this.getWithClient(client, versionId)),
      this.activeCanonical(versionId, this.transaction),
    ]);
    return { ...entry, canonicalRevisionId };
  }

  async evidence(admin: AdminContext, sourceId?: string, fileId?: string, search = ""): Promise<{ boundaries: readonly EditorEvidenceBoundary[]; chunks: readonly EditorEvidenceChunk[] }> {
    assertAdminContext(admin);
    if ((sourceId && !fileId) || (!sourceId && fileId)) throw new EntryEditorError("sourceId and fileId must be selected together.");
    if (sourceId) { requireUuid(sourceId, "sourceId"); requireUuid(fileId!, "fileId"); }
    if (search.length > 200) throw new EntryEditorError("Evidence search is too long.");
    return this.transaction(async (client) => {
      const boundaries = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT s.id AS source_id,s.title AS source_title,s.edition,s.language,f.id AS file_id,f.original_filename AS file_name
        FROM sources s JOIN files f ON f.source_id=s.id
        WHERE s.deleted_at IS NULL AND f.deleted_at IS NULL AND f.active_generation_id IS NOT NULL
        ORDER BY s.title,f.original_filename`);
      let chunks: EditorEvidenceChunk[] = [];
      if (sourceId && fileId) {
        const result = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT c.id,c.generation_id,c.quote_text,c.page_number,c.section_heading
          FROM chunks c JOIN files f ON f.id=c.file_id AND f.active_generation_id=c.generation_id
          WHERE c.source_id=$1 AND c.file_id=$2 AND c.page_number IS NOT NULL AND ($3='' OR c.quote_text ILIKE '%' || $3 || '%' OR coalesce(c.section_heading,'') ILIKE '%' || $3 || '%')
          ORDER BY c.page_number NULLS LAST,c.chunk_index LIMIT 100`, [sourceId,fileId,search.trim()]);
        chunks = result.rows.map((row) => ({ id:String(row.id),generationId:String(row.generation_id),quote:String(row.quote_text),page:row.page_number == null ? null : Number(row.page_number),section:row.section_heading == null ? null : String(row.section_heading) }));
      }
      return { boundaries: boundaries.rows.map((row) => ({ sourceId:String(row.source_id),sourceTitle:String(row.source_title),edition:String(row.edition),language:String(row.language),fileId:String(row.file_id),fileName:String(row.file_name) })), chunks };
    });
  }

  async create(admin: AdminContext, value: unknown) {
    assertAdminContext(admin);
    const input = parseEditorEntryInput(value);
    return this.compendium.createDraft({ ...input, body: blocksToBody(input.blocks), extensionData: editorExtension(input.blocks), actor: admin.userId, reason: input.reason });
  }

  async correct(admin: AdminContext, versionId: string, value: unknown): Promise<string> {
    assertAdminContext(admin); requireUuid(versionId, "versionId");
    const entry = await this.get(admin, versionId);
    const input = parseEditorCorrectionInput(value, entry.entryType);
    return this.compendium.createRevision(versionId, { ...input, body: blocksToBody(input.blocks), extensionData: editorExtension(input.blocks), actor: admin.userId, reason: input.reason });
  }

  async requestPublication(admin: AdminContext, versionId: string, value: unknown): Promise<{ status: "queued" | "pending" }> {
    assertAdminContext(admin); requireUuid(versionId, "versionId");
    if (!isRecord(value) || Object.keys(value).some((key) => !["action","revisionId","expectedActiveRevisionId","reason"].includes(key)) || !["publish", "unpublish"].includes(String(value.action)) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.trim().length > 1_000) throw new EntryEditorError("Action and a reason of at most 1000 characters are required.");
    const reason = value.reason.trim();
    const action = value.action as "publish" | "unpublish";
    const revisionId = action === "publish" ? String(value.revisionId ?? "") : null;
    if (revisionId) requireUuid(revisionId, "revisionId");
    const expectedCanonical = value.expectedActiveRevisionId === null ? null : String(value.expectedActiveRevisionId ?? "");
    if (expectedCanonical !== null && !/^rev-[0-9a-f]{64}$/.test(expectedCanonical)) throw new EntryEditorError("Invalid active canonical revision token.");
    const actualCanonical = await this.activeCanonical(versionId, this.transaction);
    if (actualCanonical !== expectedCanonical) throw new EntryEditorError("The canonical entry changed after this editor was opened. Reload before publishing.", 409);
    if (action === "unpublish") {
      try { await assertDeletionContractSupported(getDataRoot()); }
      catch (error) {
        if (error instanceof ContentIntegrityError || error instanceof ContentSchemaValidationError) throw new EntryEditorError(error.message, 409);
        throw error;
      }
    }

    const prepared = await this.transaction(async (client) => {
      const entry = await this.getWithClient(client, versionId, true);
      const revision = revisionId ? entry.revisions.find((item) => item.id === revisionId) : null;
      if (action === "publish" && !revision) throw new EntryEditorError("Revision does not belong to this entry.", 404);
      if (revision && revision.id !== entry.editorHeadRevisionId) throw new EntryEditorError("This revision is not the latest editor revision. Reload before publishing.", 409);
      const canonical = revision ? await buildEditorCanonicalRevision(client, admin, entry, revision) : null;
      if (canonical) {
        try { assertCanonicalRevision(canonical); }
        catch (error) {
          if (error instanceof ContentIntegrityError || error instanceof ContentSchemaValidationError) throw new EntryEditorError(error.message, 409);
          throw error;
        }
      }
      const open = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT idempotency_key,status,action,revision_id,expected_active_revision_id FROM compendium_editor_publications WHERE version_id=$1 AND status IN ('pending','queued') FOR UPDATE`, [versionId]);
      const existing = open.rows[0];
      if (existing) {
        const same = existing.action === action && (existing.revision_id == null ? null : String(existing.revision_id)) === revisionId && (existing.expected_active_revision_id == null ? null : String(existing.expected_active_revision_id)) === expectedCanonical;
        if (!same) throw new EntryEditorError("Another publication command is already open for this entry.", 409);
        return { entry, idempotencyKey:String(existing.idempotency_key), canonical, existingStatus:String(existing.status) };
      }
      const idempotencyKey = `editor-${versionId.replaceAll("-", "")}-${Date.now().toString(36)}`;
      await client.query(`INSERT INTO compendium_editor_publications (version_id,revision_id,action,idempotency_key,expected_active_revision_id,canonical_revision_id,actor,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [versionId, revisionId, action, idempotencyKey, expectedCanonical, canonical?.revisionId ?? null, admin.userId, reason]);
      await audit(client, versionId, revisionId, `${action}_requested`, admin.userId, reason, { expectedActiveRevisionId: expectedCanonical, canonicalRevisionId: canonical?.revisionId ?? null });
      return { entry, idempotencyKey, canonical, existingStatus:null };
    });
    if (prepared.existingStatus === "queued") return { status: "queued" };
    try {
      if (prepared.canonical) await this.submitters.publish({ idempotencyKey: prepared.idempotencyKey, expectedActiveRevisionId: expectedCanonical, revision: prepared.canonical });
      else await this.submitters.unpublish({ idempotencyKey: prepared.idempotencyKey, expectedActiveRevisionId: expectedCanonical, entryId: editorCanonicalEntryId(prepared.entry.entryType, prepared.entry.canonicalKey) });
      await this.transaction(async (client) => { await client.query("UPDATE compendium_editor_publications SET status='queued' WHERE idempotency_key=$1 AND status='pending'", [prepared.idempotencyKey]); });
      return { status: "queued" };
    } catch (error) { return editorSubmissionErrorStatus(error); }
  }

  private async getWithClient(client: DbClient, versionId: string, lock = false): Promise<EditorEntry> {
    if (lock) {
      const locked = await client.query("SELECT id FROM compendium_versions WHERE id=$1 FOR UPDATE", [versionId]);
      if (!locked.rows[0]) throw new EntryEditorError("Compendium entry was not found.", 404);
    }
    const base = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT v.id AS version_id,v.entry_id,e.canonical_key,v.entry_type,v.edition,v.language,v.source_id,v.file_id,v.active_revision_id,v.editor_head_revision_id,v.lifecycle AS version_lifecycle,
      n.name AS slug,coalesce(array_agg(a.name ORDER BY a.name) FILTER (WHERE a.name IS NOT NULL),'{}') AS aliases,
      p.canonical_revision_id,coalesce(p.status::text,'unpublished') AS publication_status,p.action AS publication_action
      FROM compendium_versions v JOIN compendium_entries e ON e.id=v.entry_id JOIN compendium_names n ON n.version_id=v.id AND n.kind='slug'
      LEFT JOIN compendium_names a ON a.version_id=v.id AND a.kind='alias'
      LEFT JOIN LATERAL (SELECT status,action,canonical_revision_id FROM compendium_editor_publications WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
      WHERE v.id=$1 GROUP BY v.id,e.canonical_key,n.name,p.status,p.action,p.canonical_revision_id`, [versionId]);
    const summary = base.rows[0]; if (!summary) throw new EntryEditorError("Compendium entry was not found.", 404);
    const entryType = String(summary.entry_type) as CompendiumEntryType;
    const revisions = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT r.*,to_jsonb(t)-'revision_id'-'entry_type' AS projection,
      coalesce(jsonb_agg(jsonb_build_object('chunkId',c.chunk_id,'generationId',c.generation_id,'kind',c.kind,'fieldPath',c.field_path,'blockOrder',c.block_order,'quote',c.quote,'quoteSpanStart',c.quote_span_start,'quoteSpanEnd',c.quote_span_end,'page',ch.page_number,'section',coalesce(ch.section_heading,r.title),'generationStatus',g.status) ORDER BY c.block_order,c.id) FILTER (WHERE c.id IS NOT NULL),'[]') AS citations
      FROM compendium_revisions r JOIN compendium_${TYPE_TABLE[entryType]} t ON t.revision_id=r.id LEFT JOIN compendium_citations c ON c.revision_id=r.id LEFT JOIN chunks ch ON ch.id=c.chunk_id AND ch.generation_id=c.generation_id AND ch.file_id=c.file_id AND ch.source_id=c.source_id LEFT JOIN ingestion_generations g ON g.id=c.generation_id AND g.file_id=c.file_id AND g.source_id=c.source_id
      WHERE r.version_id=$1 GROUP BY r.id,t.revision_id ORDER BY r.revision_number DESC`, [versionId]);
    const publications = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT * FROM compendium_editor_publications WHERE version_id=$1 ORDER BY created_at DESC,id DESC`, [versionId]);
    const auditEvents = await client.query<QueryResultRow & Record<string, unknown>>(`SELECT * FROM compendium_editor_audit WHERE version_id=$1 ORDER BY created_at DESC,id DESC`, [versionId]);
    return { ...mapEntrySummary(summary), revisions: revisions.rows.map(mapRevision), publications: publications.rows.map(mapPublication), audit: auditEvents.rows.map(mapAudit) };
  }
}

export async function recordEditorPublicationOutcome(idempotencyKey: string, status: "completed" | "failed", lastError: string | null, transaction: TransactionRunner = withTransaction as TransactionRunner): Promise<void> {
  if (!idempotencyKey.startsWith("editor-")) return;
  if (status === "failed" && !lastError) throw new TypeError("Failed publication outcomes require an error.");
  await transaction(async (client) => {
    const result = await client.query<QueryResultRow & Record<string, unknown>>(`UPDATE compendium_editor_publications SET status=$2,last_error=$3,completed_at=now()
      WHERE idempotency_key=$1 AND status IN ('pending','queued') RETURNING version_id,revision_id,action,actor,reason,canonical_revision_id`, [idempotencyKey,status,status === "failed" ? lastError ?? "Publication failed." : null]);
    const row = result.rows[0]; if (!row) return;
    if (status === "completed" && row.action === "publish") {
      await client.query("UPDATE compendium_revisions SET lifecycle='published',published_at=now() WHERE id=$1 AND lifecycle='draft'", [row.revision_id]);
      await client.query("UPDATE compendium_versions SET lifecycle='published',active_revision_id=$2,published_at=coalesce(published_at,now()),retired_at=NULL WHERE id=$1", [row.version_id,row.revision_id]);
    }
    await audit(client,String(row.version_id),row.revision_id == null ? null : String(row.revision_id),`publication_${status}`,"publication-worker",String(row.reason),{ action: row.action, initiatingActor: row.actor, error: status === "failed" ? lastError : undefined });
  });
}

async function defaultActiveCanonical(versionId: string, transaction: TransactionRunner): Promise<string | null> {
  const identity = await transaction(async (client) => (await client.query<{ canonical_key: string; entry_type: CompendiumEntryType }>("SELECT e.canonical_key,v.entry_type FROM compendium_versions v JOIN compendium_entries e ON e.id=v.entry_id WHERE v.id=$1", [versionId])).rows[0]);
  if (!identity) throw new EntryEditorError("Compendium entry was not found.", 404);
  const resolved = await loadResolvedRepositoryManifest(getDataRoot());
  return resolved.manifest.entries.find((item) => item.entryId === editorCanonicalEntryId(identity.entry_type, identity.canonical_key))?.revisionId ?? null;
}

export function editorCanonicalEntryId(entryType: CompendiumEntryType, canonicalKey: string): string { return canonicalEntryId(entryType, canonicalKey); }

export function editorSubmissionErrorStatus(error: unknown): { status: "pending" } {
  if (error instanceof PublicationEnqueueAmbiguousError) return { status: "pending" };
  throw error;
}

export async function buildEditorCanonicalRevision(client: DbClient, admin: AdminContext, entry: EditorEntry, revision: EditorRevision): Promise<CanonicalRevision> {
  try {
    if (entry.entryType === "class") validateClassProjection(revision.projection);
    if (entry.entryType === "species") validateSpeciesProjection(revision.projection);
  } catch (error) {
    if (error instanceof HierarchyValidationError) throw new EntryEditorError(error.message, 409);
    throw error;
  }
  if (entry.entryType === "creature" && revision.projection.projectionStatus === "legacy_incomplete") {
    throw new EntryEditorError("Legacy creature projections must be completed before publication.", 409);
  }
  let source;
  try {
    const metadata = new ContentMetadataService(client as never);
    const sourceRecord = await metadata.getSource(admin, entry.sourceId);
    const files = await metadata.listFiles(admin, entry.sourceId);
    if (!sourceRecord.canonicalSourceId || sourceRecord.edition !== entry.edition || sourceRecord.language !== entry.language || !files.some((file) => file.id === entry.fileId)) {
      throw new EntryEditorError("The entry source/file boundary is deleted or no longer matches its version.", 409);
    }
    source = contentSourceFromMetadataRecord(sourceRecord, contentSourceFilesFromMetadataRecords(sourceRecord.canonicalSourceId, files));
  } catch (error) {
    if (error instanceof EntryEditorError) throw error;
    if (error instanceof ContentMetadataNotFoundError || error instanceof ContentMetadataValidationError) throw new EntryEditorError(error.message, 409);
    throw error;
  }
  const typedFields = projectionFields(revision.projection);
  let plain = revision.body;
  const sections: Array<{sectionId:string;heading:string;text:string;startOffset:number;endOffset:number}> = [{sectionId:"content",heading:revision.title,text:revision.body,startOffset:0,endOffset:revision.body.length}];
  const citations = revision.citations.map((citation,index) => {
    const page = Number(citation.page);
    if (!Number.isSafeInteger(page) || page < 1) throw new EntryEditorError("Every citation requires a positive source page.", 409);
    if (!['active','archived'].includes(String(citation.generationStatus))) throw new EntryEditorError("Citation generations must remain active or archived.", 409);
    const separator = "\n\n";
    const quote = String(citation.quote);
    const startOffset = plain.length + separator.length;
    plain += separator + quote;
    sections.push({sectionId:`evidence-${index+1}`,heading:String(citation.section),text:separator+quote,startOffset:startOffset-separator.length,endOffset:plain.length});
    return { citationId:`evidence-${index+1}`,sourceId:source.sourceId,fileId:entry.fileId,page,section:String(citation.section),quote,startOffset,endOffset:startOffset+quote.length,
      ...(citation.kind === "field" && typeof citation.fieldPath === "string" ? { fieldPath: citation.fieldPath } : {}) };
  });
  return createCanonicalRevision({ schemaVersion:1,kind:"canonicalRevision",entryId:editorCanonicalEntryId(entry.entryType,entry.canonicalKey),createdAt:revision.createdAt,source,entry:{entryType:canonicalType(entry.entryType),name:revision.title,aliases:entry.aliases,typedFields},text:{plain,sections},citations } as never);
}

function projectionFields(projection: Record<string, unknown>): JsonValue[] { return Object.entries(projection).filter(([key,value]) => !["extension_data","extensionData","projection_status","projectionStatus","class_kind","species_kind"].includes(key) && value != null).map(([key,raw]) => {const value=hierarchyTypedValue(key,raw);return { key:key.replaceAll("_","-").replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),label:key.replaceAll("_"," "),type:Array.isArray(value)&&value.every((item)=>typeof item==="string") ? "stringList" : value !== null && typeof value === "object" ? "json" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string",value:value as JsonValue };}); }
function canonicalType(type: CompendiumEntryType): "spell"|"classFeature"|"item"|"monster"|"other"|"feat"|"background"|"equipment"|"glossary" { return type === "creature" ? "monster" : type === "class" || type === "feature" ? "classFeature" : ["spell", "item", "feat", "background", "equipment", "glossary"].includes(type) ? type as "spell"|"item"|"feat"|"background"|"equipment"|"glossary" : "other"; }
function mapEntrySummary(row: Record<string, unknown>): Omit<EditorEntry,"revisions"|"publications"|"audit"> { return { versionId:String(row.version_id),entryId:String(row.entry_id),canonicalKey:String(row.canonical_key),entryType:String(row.entry_type) as CompendiumEntryType,edition:String(row.edition),language:String(row.language),sourceId:String(row.source_id),fileId:String(row.file_id),slug:String(row.slug),aliases:(row.aliases ?? []) as string[],activeRevisionId:String(row.active_revision_id),editorHeadRevisionId:String(row.editor_head_revision_id),versionLifecycle:String(row.version_lifecycle),canonicalRevisionId:row.canonical_revision_id == null ? null : String(row.canonical_revision_id),publicationStatus:String(row.publication_status),publicationAction:row.publication_action == null ? null : String(row.publication_action) }; }
function mapRevision(row: Record<string, unknown>): EditorRevision { const extension = row.extension_data as {editor?:{blocks?:unknown[]}}; return { id:String(row.id),number:Number(row.revision_number),title:String(row.title),summary:row.summary == null ? null : String(row.summary),body:String(row.body),blocks:extension?.editor?.blocks ?? [{type:"paragraph",text:String(row.body)}],projection:camelProjection(row.projection as Record<string,unknown>),citations:row.citations as Record<string,unknown>[],basedOnRevisionId:row.based_on_revision_id == null ? null : String(row.based_on_revision_id),actor:row.created_by == null ? null : String(row.created_by),reason:row.change_reason == null ? null : String(row.change_reason),createdAt:new Date(row.created_at as string|Date).toISOString(),lifecycle:String(row.lifecycle) }; }
function mapPublication(row: Record<string,unknown>): EditorPublication { return { id:String(row.id),revisionId:row.revision_id == null ? null : String(row.revision_id),action:String(row.action) as "publish"|"unpublish",status:String(row.status),canonicalRevisionId:row.canonical_revision_id == null ? null : String(row.canonical_revision_id),actor:String(row.actor),reason:String(row.reason),lastError:row.last_error == null ? null : String(row.last_error),createdAt:new Date(row.created_at as string|Date).toISOString(),completedAt:row.completed_at == null ? null : new Date(row.completed_at as string|Date).toISOString() }; }
function mapAudit(row: Record<string,unknown>): EditorAuditEvent { return { id:String(row.id),revisionId:row.revision_id == null ? null : String(row.revision_id),eventType:String(row.event_type),actor:String(row.actor),reason:String(row.reason),details:(row.details ?? {}) as Record<string,unknown>,createdAt:new Date(row.created_at as string|Date).toISOString() }; }
export function camelProjection(value: Record<string,unknown>): Record<string,unknown> {
  const aliases:Record<string,string>={casting_time:"castingTime",range_text:"range",creature_type:"creatureType",armor_classes:"armorClass",hit_points_detail:"hitPoints",challenge_rating:"challengeRating",speeds:"speeds",damage_resistances:"damageResistances",damage_immunities:"damageImmunities",condition_immunities:"conditionImmunities",passive_perception:"passivePerception",bonus_actions:"bonusActions",legendary_actions:"legendaryActions",projection_status:"projectionStatus",requires_attunement:"requiresAttunement",hit_die:"hitDie",primary_ability:"primaryAbility",spellcasting_ability:"spellcastingAbility",class_kind:"kind",species_kind:"kind",feature_kind:"featureKind",ability_scores:"abilityScores",skill_proficiencies:"skillProficiencies",prerequisite_level:"prerequisiteLevel",prerequisite_text:"prerequisiteText",cost_cp:"costCp",weight_lb:"weightLb",related_terms:"relatedTerms",extension_data:"extensionData"};
  const complete = value.projection_status === "complete";
  const omitted = complete ? ["armor_class","hit_points","speed","challenge_rating","challenge_rating_numerator","challenge_rating_denominator"] : ["armor_class","hit_points","speed","armor_classes","hit_points_detail","speeds","abilities","saves","skills","damage_resistances","damage_immunities","condition_immunities","senses","passive_perception","languages","traits","actions","bonus_actions","reactions","legendary_actions","challenge_rating_numerator","challenge_rating_denominator"];
  const mapped=Object.fromEntries(Object.entries(value).filter(([key])=>!omitted.includes(key)).map(([key,item])=>[aliases[key]??key,item]));
  if(complete)mapped.challengeRating={numerator:Number(value.challenge_rating_numerator),denominator:Number(value.challenge_rating_denominator)};
  else {
    mapped.armorClass=[{value:Number(value.armor_class)}];
    mapped.hitPoints={average:Number(value.hit_points)};
    mapped.speeds=legacyEditorSpeeds(String(value.speed));
  }
  const extension=value.extension_data as {hierarchy?:Record<string,unknown>}|undefined;
  return {...mapped,...(extension?.hierarchy??{})};
}
function legacyEditorSpeeds(value:string): readonly Record<string,unknown>[] {
  const aliases:Record<string,string>={walk:"walk",burrow:"burrow",climb:"climb",fly:"fly",swim:"swim",ходьба:"walk",копая:"burrow",лазая:"climb",летая:"fly",лётая:"fly",плавая:"swim"};
  const modes=new Set<string>();
  return value.split(/[,;]/).flatMap((part,index)=>{
    const match=part.trim().match(/(?:(walk|burrow|climb|fly|swim|ходьба|копая|лазая|л[её]тая|плавая)\s*)?(\d+)\s*(ft|feet|фут(?:ов|а)?|m|м)\.?/iu);
    const mode=match ? aliases[match[1]?.toLocaleLowerCase("und")??""]??(index===0?"walk":"") : "";
    if(!match||!mode||modes.has(mode))return [];
    modes.add(mode);
    return [{mode,distance:Number(match[2]),unit:/^(?:m|м)$/iu.test(match[3])?"m":"ft"}];
  });
}
async function audit(client: DbClient,versionId:string,revisionId:string|null,eventType:string,actor:string,reason:string,details:Record<string,unknown>) { await client.query("INSERT INTO compendium_editor_audit(version_id,revision_id,event_type,actor,reason,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[versionId,revisionId,eventType,actor,reason,JSON.stringify(details)]); }
function requireUuid(value:string,field:string) { if (!UUID.test(value)) throw new EntryEditorError(`${field} must be a UUID.`); }
function isRecord(value:unknown): value is Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
