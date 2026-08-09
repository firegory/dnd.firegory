export type UploadSourceFormState = Readonly<{
  title: string;
  category: string;
  edition: string;
  language: string;
  accessTier: string;
  canonicalSourceId: string;
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
  };
}

export function resetUploadSourceFormState(current: UploadSourceFormState): UploadSourceFormState {
  return createUploadSourceFormState({ edition: current.edition, language: current.language });
}
