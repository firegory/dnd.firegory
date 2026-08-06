export type UploadSourceFormState = Readonly<{
  title: string;
  category: string;
  edition: string;
  language: string;
  accessTier: string;
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

export function createUploadSourceFormState(
  defaults: Partial<Pick<UploadSourceFormState, "edition" | "language">> = {},
): UploadSourceFormState {
  return {
    title: "",
    category: "core_rules",
    edition: defaults.edition ?? "5.5e",
    language: defaults.language ?? "ru",
    accessTier: "open",
    canonicalSourceId: "",
    publicationCode: "",
    publicationTitle: "",
    publisher: "",
    releaseYear: "",
    revision: "",
    originUrl: "",
    originId: "",
    attribution: "",
    sourcePriority: "0",
    canonicalBookId: "",
    license: "",
  };
}

export function resetUploadSourceFormState(current: UploadSourceFormState): UploadSourceFormState {
  return createUploadSourceFormState({ edition: current.edition, language: current.language });
}
