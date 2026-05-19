/**
 * Pure validation helpers for the ingestion CLI.
 *
 * Extracted from scripts/ingest.mts so that argument validation
 * can be unit-tested without side effects (process.exit, file I/O, DB).
 */

import type {
  AccessTier,
  SourceCategory,
  SourceEdition,
  SourceLanguage,
} from "../server/access/retrieval-filter.ts";

export const VALID_CATEGORIES: readonly SourceCategory[] = ["core_rules", "official_supplement", "homebrew"];
export const VALID_EDITIONS: readonly SourceEdition[] = ["5e", "5.5e"];
export const VALID_LANGUAGES: readonly SourceLanguage[] = ["en", "ru"];
export const VALID_ACCESS_TIERS: readonly AccessTier[] = ["open", "premium", "personal"];

/**
 * Validates that a value is one of the allowed enum values.
 * Returns the typed value or throws a descriptive Error.
 */
export function validateEnum<T extends string>(
  value: string,
  valid: readonly T[],
  label: string,
): T {
  if (!valid.includes(value as T)) {
    throw new Error(
      `${label} must be one of: ${valid.join(", ")}. Got: "${value}"`,
    );
  }
  return value as T;
}

export interface ParsedIngestionArgs {
  pdf: string;
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  access: AccessTier;
  ownerUserId?: string;
}

/**
 * Validates raw string input for all CLI metadata arguments.
 * Returns typed, validated args or throws on invalid input.
 */
export function validateIngestionArgs(input: {
  pdf?: string;
  title?: string;
  category?: string;
  edition?: string;
  language?: string;
  access?: string;
  ownerUserId?: string;
}): ParsedIngestionArgs {
  const missing: string[] = [];
  if (!input.pdf) missing.push("--pdf");
  if (!input.title) missing.push("--title");
  if (!input.category) missing.push("--category");
  if (!input.edition) missing.push("--edition");
  if (!input.language) missing.push("--language");
  if (!input.access) missing.push("--access");

  if (missing.length > 0) {
    throw new Error(`missing required option(s): ${missing.join(", ")}`);
  }

  return {
    pdf: input.pdf!,
    title: input.title!,
    category: validateEnum(input.category!, VALID_CATEGORIES, "--category"),
    edition: validateEnum(input.edition!, VALID_EDITIONS, "--edition"),
    language: validateEnum(input.language!, VALID_LANGUAGES, "--language"),
    access: validateEnum(input.access!, VALID_ACCESS_TIERS, "--access"),
    ownerUserId: input.ownerUserId,
  };
}
