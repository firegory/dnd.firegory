import {
  ContentMetadataValidationError,
  type PublicationMetadataInput,
} from "../content/metadata.ts";

export type UploadSourceMetadata = Readonly<{
  canonicalSourceId: string | null;
  publication: PublicationMetadataInput;
  license: string | null;
}>;

export function parseUploadSourceMetadata(formData: FormData, title: string): UploadSourceMetadata {
  const originUrl = optionalText(formData, "originUrl");
  const originId = optionalText(formData, "originId");

  return {
    canonicalSourceId: optionalText(formData, "canonicalSourceId"),
    publication: {
      code: optionalText(formData, "publicationCode"),
      title: optionalText(formData, "publicationTitle") ?? title,
      publisher: optionalText(formData, "publisher"),
      releaseYear: optionalInteger(formData, "releaseYear"),
      revision: optionalText(formData, "revision"),
      origin: originUrl || originId ? { url: originUrl, id: originId } : null,
      attribution: optionalText(formData, "attribution"),
      sourcePriority: optionalInteger(formData, "sourcePriority") ?? 0,
      canonicalBookId: optionalText(formData, "canonicalBookId"),
    },
    license: optionalText(formData, "license"),
  };
}

function optionalText(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  if (value === null) return null;
  if (typeof value !== "string") throw new ContentMetadataValidationError(`${name} must be text.`);
  return value.trim() || null;
}

function optionalInteger(formData: FormData, name: string): number | null {
  const value = optionalText(formData, name);
  if (value === null) return null;
  if (!/^-?\d+$/.test(value)) throw new ContentMetadataValidationError(`${name} must be an integer.`);
  return Number(value);
}
