import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { CanonicalRevision, ContentSource, JsonValue } from "../content-storage/repository.ts";
import { canonicalJson } from "../content-storage/repository.ts";
import { chunkPage } from "../../worker/ingestion/chunking.ts";

type Citation = Readonly<{
  fileId: string;
  page: number;
  section: string;
  startOffset: number;
  endOffset: number;
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
  file: ContentSource["files"][number];
  sourceUuid: string;
  fileUuid: string;
  generationId: string;
  documentId: string;
  pages: readonly Readonly<{ pageNumber: number; text: string }>[];
  chunks: readonly IndexedChunk[];
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
): readonly IndexedEntryProjection[] {
  const sorted = [...revisions].sort((left, right) => left.entryId.localeCompare(right.entryId));
  const fileRevisionIds = new Map<string, string[]>();
  for (const revision of sorted) {
    const citation = (revision.citations as readonly unknown[])[0] as Citation;
    const key = `${revision.source.sourceId}/${citation.fileId}`;
    fileRevisionIds.set(key, [...(fileRevisionIds.get(key) ?? []), revision.revisionId]);
  }

  const fileChunkIndexes = new Map<string, number>();
  return sorted.map((revision) => {
    const citations = revision.citations as unknown as readonly Citation[];
    const sections = revision.text.sections as unknown as readonly Section[];
    const primaryCitation = citations[0];
    const file = revision.source.files.find((candidate) => candidate.fileId === primaryCitation.fileId);
    if (!file) throw new Error(`Revision ${revision.revisionId} has no primary source file`);
    const fileKey = `${revision.source.sourceId}/${file.fileId}`;
    const generationId = deterministicUuid(
      "nfs-index-generation",
      repositoryId,
      fileKey,
      ...(fileRevisionIds.get(fileKey) ?? []).sort(),
    );
    const sourceUuid = deterministicUuid("nfs-index-source", repositoryId, revision.source.sourceId);
    const fileUuid = deterministicUuid("nfs-index-file", repositoryId, revision.source.sourceId, file.fileId);
    const documentId = deterministicUuid("nfs-index-document", repositoryId, generationId, revision.entryId, revision.revisionId);
    const chunks: IndexedChunk[] = [];

    for (const section of sections) {
      const citation = citations.find((candidate) =>
        candidate.fileId === file.fileId
        && candidate.startOffset < section.endOffset
        && candidate.endOffset > section.startOffset
      ) ?? primaryCitation;
      const startIndex = fileChunkIndexes.get(fileKey) ?? 0;
      const projected = chunkPage({
        pageNumber: citation.page,
        text: section.text,
        sectionHeading: section.heading,
      }, startIndex);
      fileChunkIndexes.set(fileKey, startIndex + projected.length);
      for (const chunk of projected) {
        const textSpanStart = section.startOffset + chunk.textSpanStart;
        const textSpanEnd = section.startOffset + chunk.textSpanEnd;
        const chunkCitation = citations.find((candidate) =>
          candidate.fileId === file.fileId
          && candidate.startOffset <= textSpanStart
          && candidate.endOffset >= textSpanEnd
        );
        chunks.push({
          id: deterministicUuid("nfs-index-chunk", repositoryId, generationId, revision.revisionId, section.sectionId, String(chunk.chunkIndex)),
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          quoteText: chunk.quoteText,
          pageNumber: chunkCitation?.page ?? null,
          sectionHeading: section.heading,
          textSpanStart,
          textSpanEnd,
          metadata: {
            managedBy: "nfs-content-index",
            repositoryId,
            entryId: revision.entryId,
            revisionId: revision.revisionId,
            sectionId: section.sectionId,
          },
        });
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
        citations.filter((citation) => citation.fileId === file.fileId),
        (citation) => citation.page,
      )].sort(([left], [right]) => left - right).map(([pageNumber, pageCitations]) => ({
        pageNumber,
        text: [...new Set(pageCitations.map((citation) =>
          String(revision.text.plain).slice(citation.startOffset, citation.endOffset)
        ))].join("\n"),
      })),
      chunks,
    };
  });
}

export function projectionHash(repositoryId: string, revisions: readonly CanonicalRevision[]): string {
  const identity = revisions
    .map((revision) => ({ entryId: revision.entryId, revisionId: revision.revisionId, contentHash: revision.contentHash }))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
  return `sha256:${createHash("sha256").update(canonicalJson({ repositoryId, entries: identity } as JsonValue)).digest("hex")}`;
}

export function sourceFilename(path: string): string {
  return basename(path);
}
