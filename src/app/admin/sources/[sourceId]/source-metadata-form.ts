import type { SourceMetadataRecord, UpdateSourceMetadataInput } from "../../../../server/content/metadata";

export type SourceMetadataFormState = Readonly<{
  title: string;
  category: SourceMetadataRecord["category"];
  edition: SourceMetadataRecord["edition"];
  language: SourceMetadataRecord["language"];
  accessTier: SourceMetadataRecord["accessTier"];
  ownerUserId: string;
  canonicalSourceId: string;
  publicationCode: string;
  publicationTitle: string;
  publisher: string;
  releaseYear: string;
  revision: string;
  originUrl: string;
  originId: string;
  attribution: string;
  sourcePriority: string;
  canonicalBookId: string;
  license: string;
}>;

export function createSourceMetadataFormState(source: SourceMetadataRecord): SourceMetadataFormState {
  return {
    title: source.title,
    category: source.category,
    edition: source.edition,
    language: source.language,
    accessTier: source.accessTier,
    ownerUserId: source.ownerUserId ?? "",
    canonicalSourceId: source.canonicalSourceId ?? "",
    publicationCode: source.publication.code ?? "",
    publicationTitle: source.publication.title,
    publisher: source.publication.publisher ?? "",
    releaseYear: source.publication.releaseYear?.toString() ?? "",
    revision: source.publication.revision ?? "",
    originUrl: source.publication.origin?.url ?? "",
    originId: source.publication.origin?.id ?? "",
    attribution: source.publication.attribution ?? "",
    sourcePriority: source.publication.sourcePriority.toString(),
    canonicalBookId: source.publication.canonicalBookId ?? "",
    license: source.license ?? "",
  };
}

export function sourceMetadataPatchFromForm(state: SourceMetadataFormState): UpdateSourceMetadataInput {
  return {
    canonicalSourceId: state.canonicalSourceId || null,
    title: state.title,
    category: state.category,
    edition: state.edition,
    language: state.language,
    accessTier: state.accessTier,
    ownerUserId: state.accessTier === "personal" ? state.ownerUserId || null : null,
    publication: {
      code: state.publicationCode || null,
      title: state.publicationTitle,
      publisher: state.publisher || null,
      releaseYear: state.releaseYear ? Number(state.releaseYear) : null,
      revision: state.revision || null,
      origin: state.originUrl || state.originId
        ? { url: state.originUrl || null, id: state.originId || null }
        : null,
      attribution: state.attribution || null,
      sourcePriority: Number(state.sourcePriority),
      canonicalBookId: state.canonicalBookId || null,
    },
    license: state.license || null,
  };
}
