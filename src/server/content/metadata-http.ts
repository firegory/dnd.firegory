import {
  ContentMetadataNotFoundError,
  ContentMetadataValidationError,
} from "./metadata.ts";

export type ContentMetadataHttpError = Readonly<{
  status: 400 | 404;
  body: Readonly<{ error: string }>;
}>;

export function mapContentMetadataHttpError(error: unknown): ContentMetadataHttpError | null {
  if (error instanceof ContentMetadataValidationError) {
    return { status: 400, body: { error: error.message } };
  }
  if (error instanceof ContentMetadataNotFoundError) {
    return { status: 404, body: { error: error.message } };
  }
  return null;
}
