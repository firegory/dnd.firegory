import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { CanonicalRevision, ContentSource, JsonValue } from "../content-storage/repository.ts";
import { canonicalJson } from "../content-storage/repository.ts";
import type { ValidatedSourceFile } from "../content-storage/validation.ts";
import { chunkPage } from "../../worker/ingestion/chunking.ts";
import { classProjectionFromTypedFields, speciesProjectionFromTypedFields } from "../compendium/hierarchy-schema.ts";

export const CONTENT_INDEX_PROJECTOR_VERSION = 5 as const;

type Citation = Readonly<{
  citationId: string;
  fileId: string;
  page: number | null;
  section: string;
  quote: string;
  startOffset: number | null;
  endOffset: number | null;
  fieldPath?: string;
  sourceUrl?: string;
}>;

export type IndexedCitation = Readonly<{
  citationId: string;
  page: number | null;
  section: string;
  quote: string;
  startOffset: number | null;
  endOffset: number | null;
  fieldPath?: string;
  sourceUrl?: string;
}>;

type Section = Readonly<{
  sectionId: string;
  heading: string;
  text: string;
  startOffset: number;
  endOffset: number;
}>;

export type IndexedChunk = Readonly<{
  id: string;
  chunkIndex: number;
  text: string;
  quoteText: string;
  pageNumber: number | null;
  sectionHeading: string;
  textSpanStart: number;
  textSpanEnd: number;
  metadata: Readonly<Record<string, JsonValue>>;
}>;

export type IndexedEntryProjection = Readonly<{
  id: string;
  entryId: string;
  revisionId: string;
  contentHash: string;
  entryType: string;
  name: string;
  aliases: readonly JsonValue[];
  typedFields: readonly JsonValue[];
  plainText: string;
  canonicalPayload: CanonicalRevision;
  source: ContentSource;
  file: ContentSource["files"][number] & Readonly<{ byteSize: number }>;
  sourceUuid: string;
  fileUuid: string;
  generationId: string;
  documentId: string;
  pages: readonly Readonly<{ pageNumber: number; text: string; citations: readonly IndexedCitation[] }>[];
  chunks: readonly IndexedChunk[];
  relations: readonly IndexedOptionRelation[];
}>;

export type IndexedOptionRelation = Readonly<{
  sourceEntryId: string; sourceRevisionId: string; sourceId: string;
  targetEntryId: string; targetRevisionId: string; targetSourceId: string;
  edition: "5e" | "5.5e"; language: "en" | "ru";
  relationKind: "parent" | "feature" | "cross_link" | "trait_override";
  targetKind: "class" | "subclass" | "species" | "variant" | "feature" | "other";
  targetLifecycle: "active"; sourceAnchor: string; anchor: string | null; position: number;
}>;

export function deterministicUuid(namespace: string, ...parts: readonly string[]): string {
  const bytes = createHash("sha256").update([namespace, ...parts].join("\0"), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function projectCanonicalRevisions(
  repositoryId: string,
  revisions: readonly CanonicalRevision[],
  sourceFiles: readonly ValidatedSourceFile[],
): readonly IndexedEntryProjection[] {
  const sorted = [...revisions].sort((left, right) => left.entryId.localeCompare(right.entryId));
  const fileRevisionIds = new Map<string, string[]>();
  for (const revision of sorted) {
    const citations = revision.citations as unknown as readonly Citation[];
    const citedFileIds = new Set(citations.map((citation) => citation.fileId));
    if (citedFileIds.size !== 1) {
      throw new Error(`Revision ${revision.revisionId} cites multiple source files; projector version ${CONTENT_INDEX_PROJECTOR_VERSION} requires one cited file`);
    }
    assertUnambiguousCitations(revision.revisionId, citations);
    const citation = citations[0];
    const key = `${revision.source.sourceId}/${citation.fileId}`;
    fileRevisionIds.set(key, [...(fileRevisionIds.get(key) ?? []), revision.revisionId]);
  }

  const fileChunkIndexes = new Map<string, number>();
  const projected = sorted.map((revision) => {
    const citations = revision.citations as unknown as readonly Citation[];
    const sections = revision.text.sections as unknown as readonly Section[];
    const primaryCitation = citations[0];
    const declaredFile = revision.source.files.find((candidate) => candidate.fileId === primaryCitation.fileId);
    const capturedFile = sourceFiles.find((candidate) =>
      candidate.sourceId === revision.source.sourceId && candidate.fileId === primaryCitation.fileId
    );
    if (!declaredFile || !capturedFile) throw new Error(`Revision ${revision.revisionId} has no captured cited source file`);
    const file = { ...declaredFile, byteSize: capturedFile.byteSize };
    const fileKey = `${revision.source.sourceId}/${file.fileId}`;
    const generationId = deterministicUuid(
      "nfs-index-generation",
      String(CONTENT_INDEX_PROJECTOR_VERSION),
      repositoryId,
      fileKey,
      ...(fileRevisionIds.get(fileKey) ?? []).sort(),
    );
    const sourceUuid = deterministicUuid("nfs-index-source", repositoryId, revision.source.sourceId);
    const fileUuid = deterministicUuid("nfs-index-file", repositoryId, revision.source.sourceId, file.fileId);
    const documentId = deterministicUuid("nfs-index-document", repositoryId, generationId, revision.entryId, revision.revisionId);
    const chunks: IndexedChunk[] = [];

    for (const section of sections) {
      const boundaries = new Set([section.startOffset, section.endOffset]);
      for (const citation of citations) {
        if (citation.startOffset !== null && citation.endOffset !== null
            && citation.startOffset < section.endOffset && citation.endOffset > section.startOffset) {
          boundaries.add(Math.max(section.startOffset, citation.startOffset));
          boundaries.add(Math.min(section.endOffset, citation.endOffset));
        }
      }
      const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
      for (let segmentIndex = 0; segmentIndex < orderedBoundaries.length - 1; segmentIndex++) {
        const segmentStart = orderedBoundaries[segmentIndex];
        const segmentEnd = orderedBoundaries[segmentIndex + 1];
        const segmentText = String(revision.text.plain).slice(segmentStart, segmentEnd);
        const segmentCitations = citations.filter((candidate) => candidate.startOffset === null
          || candidate.endOffset === null
          || (candidate.startOffset <= segmentStart && candidate.endOffset >= segmentEnd));
        const citation = segmentCitations[0];
        const startIndex = fileChunkIndexes.get(fileKey) ?? 0;
        const projected = chunkPage({
          pageNumber: citation?.page ?? primaryCitation.page ?? 1,
          text: segmentText,
          sectionHeading: citation?.section ?? section.heading,
        }, startIndex);
        fileChunkIndexes.set(fileKey, startIndex + projected.length);
        for (const chunk of projected) {
          const textSpanStart = segmentStart + chunk.textSpanStart;
          const textSpanEnd = segmentStart + chunk.textSpanEnd;
          chunks.push({
            id: deterministicUuid("nfs-index-chunk", repositoryId, generationId, revision.revisionId, section.sectionId, String(chunk.chunkIndex)),
            chunkIndex: chunk.chunkIndex,
            text: chunk.text,
            quoteText: chunk.quoteText,
            pageNumber: citation?.page ?? null,
            sectionHeading: citation?.section ?? section.heading,
            textSpanStart,
            textSpanEnd,
            metadata: {
              managedBy: "nfs-content-index",
              repositoryId,
              entryId: revision.entryId,
              revisionId: revision.revisionId,
              sectionId: section.sectionId,
              citations: segmentCitations.map(indexedCitation),
            },
          });
        }
      }
    }

    return {
      id: deterministicUuid("nfs-index-entry", repositoryId, revision.entryId),
      entryId: revision.entryId,
      revisionId: revision.revisionId,
      contentHash: revision.contentHash,
      entryType: String(revision.entry.entryType),
      name: String(revision.entry.name),
      aliases: revision.entry.aliases as readonly JsonValue[],
      typedFields: revision.entry.typedFields as readonly JsonValue[],
      plainText: String(revision.text.plain),
      canonicalPayload: revision,
      source: revision.source,
      file,
      sourceUuid,
      fileUuid,
      generationId,
      documentId,
      pages: [...Map.groupBy(
        citations.filter((citation): citation is Citation & { page: number; startOffset: number; endOffset: number } =>
          citation.fileId === file.fileId && citation.page !== null && citation.startOffset !== null && citation.endOffset !== null),
        (citation) => citation.page,
      )].sort(([left], [right]) => left - right).map(([pageNumber, pageCitations]) => ({
        pageNumber,
        text: [...new Set(pageCitations.map((citation) =>
          String(revision.text.plain).slice(citation.startOffset, citation.endOffset)
        ))].join("\n"),
        citations: pageCitations.map(indexedCitation),
      })),
      chunks,
      relations: [],
    };
  });
  return resolveOptionRelations(projected);
}

function resolveOptionRelations(entries: readonly IndexedEntryProjection[]): readonly IndexedEntryProjection[] {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const projectionById = new Map<string, ReturnType<typeof classProjectionFromTypedFields> | ReturnType<typeof speciesProjectionFromTypedFields>>();
  const targetKind = (target: IndexedEntryProjection): IndexedOptionRelation["targetKind"] => {
    if (target.entryId.startsWith("class-")) return (projectionById.get(target.entryId) ?? classProjectionFromTypedFields(target.typedFields)).kind;
    if (target.entryId.startsWith("species-")) return (projectionById.get(target.entryId) ?? speciesProjectionFromTypedFields(target.typedFields)).kind;
    if (target.entryId.startsWith("feature-")) return "feature";
    return "other";
  };
  const resolve = (source: IndexedEntryProjection, targetId: string, relationKind: IndexedOptionRelation["relationKind"], anchor: string | null, position: number, sourceAnchor = ""): IndexedOptionRelation => {
    const target = byId.get(targetId);
    if (!target || target.source.sourceId !== source.source.sourceId || target.source.edition !== source.source.edition || target.source.language !== source.source.language) {
      throw new Error(`Relation ${source.entryId} -> ${targetId} requires an exact target in the same source, edition, and language snapshot`);
    }
    return { sourceEntryId:source.entryId,sourceRevisionId:source.revisionId,sourceId:source.sourceUuid,targetEntryId:target.entryId,
      targetRevisionId:target.revisionId,targetSourceId:target.sourceUuid,edition:source.source.edition,language:source.source.language,
      relationKind,targetKind:targetKind(target),targetLifecycle:"active",sourceAnchor,anchor,position };
  };
  for (const entry of entries) {
    if (entry.entryId.startsWith("class-")) projectionById.set(entry.entryId, classProjectionFromTypedFields(entry.typedFields));
    if (entry.entryId.startsWith("species-")) projectionById.set(entry.entryId, speciesProjectionFromTypedFields(entry.typedFields));
  }
  const graph = new Map<string, string[]>();
  for (const [entryId, projection] of projectionById) {
    const parents = "parentClassIds" in projection ? projection.parentClassIds : projection.parentSpeciesIds;
    graph.set(entryId, [...parents]);
  }
  for (const start of graph.keys()) assertAcyclicPathToBase(start, graph, projectionById, []);
  for (const [entryId, projection] of projectionById) if ("traits" in projection) {
    const inherited = inheritedTraitKeys(entryId, graph, projectionById, new Set());
    for (const trait of projection.traits) if (trait.overrides && !inherited.has(trait.overrides)) {
      throw new Error(`Trait override ${entryId}#${trait.anchor} does not resolve an inherited parent trait`);
    }
  }
  return entries.map((entry) => {
    const projection=projectionById.get(entry.entryId);if(!projection)return entry;const relations:IndexedOptionRelation[]=[];
    const parents="parentClassIds" in projection?projection.parentClassIds:projection.parentSpeciesIds;
    parents.forEach((id,index)=>relations.push(resolve(entry,id,"parent",null,index)));
    if("features" in projection)projection.features.forEach((feature,index)=>relations.push(resolve(entry,feature.canonicalId,"feature",feature.anchor,index)));
    if("traits" in projection) projection.traits.forEach((trait,index)=>{
      if(!trait.overrides)return;
      const parentId=parents.find((id)=>{const parent=projectionById.get(id);return parent&&"traits" in parent&&parent.traits.some(({key})=>key===trait.overrides);});
      const parent=parentId?projectionById.get(parentId):undefined;const inherited=parent&&"traits" in parent?parent.traits.find(({key})=>key===trait.overrides):undefined;
      if(!parentId||!inherited)throw new Error(`Trait override ${entry.entryId}#${trait.anchor} does not resolve an inherited parent trait`);
      relations.push(resolve(entry,parentId,"trait_override",inherited.anchor,index,trait.anchor));
    });
    projection.crossLinks.forEach((id,index)=>relations.push(resolve(entry,id,"cross_link",null,index)));
    return {...entry,relations};
  });
}

function assertAcyclicPathToBase(
  entryId:string,
  graph:ReadonlyMap<string,readonly string[]>,
  projections:ReadonlyMap<string,ReturnType<typeof classProjectionFromTypedFields>|ReturnType<typeof speciesProjectionFromTypedFields>>,
  path:readonly string[],
):void {
  if(path.includes(entryId))throw new Error(`Hierarchy cycle detected: ${[...path,entryId].join(" -> ")}`);
  const projection=projections.get(entryId);if(!projection)throw new Error(`Hierarchy target ${entryId} does not exist in the exact source snapshot`);
  const derived=projection.kind==="subclass"||projection.kind==="variant";const parents=graph.get(entryId)??[];
  if(derived&&parents.length===0)throw new Error(`Derived option ${entryId} has no explicit parent`);
  if(!derived&&parents.length>0)throw new Error(`Base option ${entryId} cannot have a parent`);
  for(const parent of parents){const target=projections.get(parent);if(!target)throw new Error(`Hierarchy parent ${parent} does not exist in the exact source snapshot`);if(("parentClassIds" in projection)!==("parentClassIds" in target))throw new Error(`Hierarchy parent ${parent} has the wrong kind`);assertAcyclicPathToBase(parent,graph,projections,[...path,entryId]);if(target.kind!==(("parentClassIds" in projection)?"class":"species"))throw new Error(`Hierarchy parent ${parent} must be a direct base option`);}
}

function inheritedTraitKeys(
  entryId:string,
  graph:ReadonlyMap<string,readonly string[]>,
  projections:ReadonlyMap<string,ReturnType<typeof classProjectionFromTypedFields>|ReturnType<typeof speciesProjectionFromTypedFields>>,
  visited:Set<string>,
):Set<string>{const result=new Set<string>();if(visited.has(entryId))return result;visited.add(entryId);for(const parent of graph.get(entryId)??[]){const projection=projections.get(parent);if(projection&&"traits" in projection)for(const trait of projection.traits)result.add(trait.key);for(const key of inheritedTraitKeys(parent,graph,projections,visited))result.add(key);}return result;}

export function projectionHash(repositoryId: string, projections: readonly IndexedEntryProjection[]): string {
  return contentProjectionHash({
    projectorVersion: CONTENT_INDEX_PROJECTOR_VERSION,
    repositoryId,
    entries: projections,
  });
}

export function entryProjectionHash(projection: IndexedEntryProjection): string {
  return contentProjectionHash({
    projectorVersion: CONTENT_INDEX_PROJECTOR_VERSION,
    projection,
  });
}

export function sourceFilename(path: string): string {
  return basename(path);
}

function indexedCitation(citation: Citation): IndexedCitation {
  return {
    citationId: citation.citationId,
    page: citation.page,
    section: citation.section,
    quote: citation.quote,
    startOffset: citation.startOffset,
    endOffset: citation.endOffset,
    ...(citation.fieldPath ? { fieldPath: citation.fieldPath } : {}),
    ...(citation.sourceUrl ? { sourceUrl: citation.sourceUrl } : {}),
  };
}

function contentProjectionHash(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function assertUnambiguousCitations(revisionId: string, citations: readonly Citation[]): void {
  for (const [index, left] of citations.entries()) {
    for (const right of citations.slice(index + 1)) {
      if (left.startOffset === null || left.endOffset === null || right.startOffset === null || right.endOffset === null) continue;
      const overlaps = left.startOffset < right.endOffset && right.startOffset < left.endOffset;
      if (overlaps && (left.page !== right.page || left.section !== right.section)) {
        throw new Error(`Revision ${revisionId} has overlapping citations with ambiguous page or section provenance`);
      }
    }
  }
}
