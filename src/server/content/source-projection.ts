import type { ContentSource } from "../content-storage/repository.ts";
import {
  ContentMetadataValidationError,
  normalizeSourceInput,
  type CreateSourceMetadataInput,
  type SourceMetadataRecord,
} from "./metadata.ts";

export function sourceMetadataInputFromContentSource(source: ContentSource): CreateSourceMetadataInput {
  return {
    canonicalSourceId: source.sourceId,
    title: source.title,
    category: source.category,
    edition: source.edition,
    language: source.language,
    accessTier: source.accessTier,
    ownerUserId: source.ownerUserId,
    publication: source.publication,
    license: source.license ?? null,
  };
}

export function contentSourceFromMetadataRecord(
  source: SourceMetadataRecord,
  files: ContentSource["files"],
): ContentSource {
  if (!source.canonicalSourceId) {
    throw new ContentMetadataValidationError("canonicalSourceId is required to serialize source.json.");
  }
  const normalized = normalizeSourceInput(source);
  const publication = normalized.publication;
  if (
    !publication.code || !publication.publisher || publication.releaseYear === null
    || !publication.canonicalBookId
  ) {
    throw new ContentMetadataValidationError("Complete publication metadata is required to serialize source.json.");
  }

  return {
    schemaVersion: 1,
    kind: "source",
    sourceId: source.canonicalSourceId,
    title: normalized.title,
    category: normalized.category,
    edition: normalized.edition,
    language: normalized.language,
    accessTier: normalized.accessTier,
    shared: normalized.shared,
    ownerUserId: normalized.ownerUserId,
    publication: {
      code: publication.code,
      title: publication.title,
      publisher: publication.publisher,
      releaseYear: publication.releaseYear,
      ...(publication.revision ? { revision: publication.revision } : {}),
      ...(publication.origin ? { origin: publication.origin } : {}),
      ...(publication.attribution ? { attribution: publication.attribution } : {}),
      sourcePriority: publication.sourcePriority,
      canonicalBookId: publication.canonicalBookId,
    },
    ...(normalized.license ? { license: normalized.license } : {}),
    files,
  };
}
