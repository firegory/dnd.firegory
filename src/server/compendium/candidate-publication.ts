import { createHash } from "node:crypto";

import {
  createCanonicalRevision,
  type CanonicalRevision,
  type ContentSource,
  type JsonValue,
} from "../content-storage/repository.ts";
import { assertCanonicalRevision } from "../content-storage/validation.ts";
import {
  EXTRACTION_SCHEMA_VERSION,
  EXTRACTION_PARSER_VERSION,
  EXTRACTION_PROMPT_VERSION,
  validateCandidateWire,
  type CandidateWire,
  type EvidenceChunk,
  type ExtractionBoundary,
} from "./candidate-schema.ts";
import type { CompendiumEntryType } from "./service.ts";

export type CandidatePublicationContext = Readonly<{
  candidateKey: string;
  entryType: CompendiumEntryType;
  createdAt: string;
  boundary: ExtractionBoundary;
  source: ContentSource;
  chunk: EvidenceChunk;
}>;

const CANONICAL_ENTRY_TYPES: Readonly<Record<CompendiumEntryType, string>> = {
  spell: "spell",
  creature: "monster",
  equipment: "item",
  feature: "classFeature",
  item: "item",
  class: "other",
  species: "other",
  background: "other",
  feat: "other",
};
const EXTRACTION_METHODS = new Set(["section-parser", "table-parser", "spell-parser", "stat-block-parser", "llm"]);
const STABLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export class CandidateProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateProjectionError";
  }
}

export function canonicalCandidateEntryId(entryType: string, candidateKey: string): string {
  if (!(entryType in CANONICAL_ENTRY_TYPES) || !STABLE_ID.test(candidateKey)) {
    throw new CandidateProjectionError("Canonical candidate identity requires a supported entry type and stable candidate key.");
  }
  const value = `${entryType}-${candidateKey}`;
  if (value.length <= 128) return value;
  const suffix = createHash("sha256").update(`${entryType}\0${candidateKey}`).digest("hex").slice(0, 16);
  return `${entryType}-${candidateKey.slice(0, 128 - entryType.length - suffix.length - 2)}-${suffix}`;
}

export function projectExtractedCandidate(value: unknown, context: CandidatePublicationContext): CanonicalRevision {
  const candidate = validateExtractedCandidate(value, context);
  const typedFields = Object.entries(candidate.attributes).map(([attribute, fieldValue]) => typedField(attribute, fieldValue));
  const plain = context.chunk.quoteText;
  if (context.chunk.pageNumber === null) throw new CandidateProjectionError("Canonical citation projection requires a positive source page.");
  const section = context.chunk.sectionHeading?.trim() || candidate.title;
  const citationCounts = new Map<string, number>();
  const citations = candidate.citations.map((citation) => {
    const startOffset = codeUnitOffset(plain, citation.quoteSpanStart);
    const endOffset = codeUnitOffset(plain, citation.quoteSpanEnd);
    const citationKey = evidenceKey(citation.fieldPath);
    const occurrence = (citationCounts.get(citationKey) ?? 0) + 1;
    citationCounts.set(citationKey, occurrence);
    return {
      citationId: `evidence-${citationKey}-${occurrence}`,
      sourceId: context.source.sourceId,
      fileId: context.boundary.fileId,
      page: context.chunk.pageNumber,
      section: `${section} [chunk ${citation.chunkId}]`,
      quote: citation.quote,
      startOffset,
      endOffset,
    };
  });
  const revision = createCanonicalRevision({
    schemaVersion: 1,
    kind: "canonicalRevision",
    entryId: canonicalCandidateEntryId(candidate.entryType, candidate.candidateKey),
    createdAt: context.createdAt,
    source: context.source,
    entry: {
      entryType: CANONICAL_ENTRY_TYPES[candidate.entryType],
      name: candidate.title,
      aliases: [],
      typedFields,
    },
    text: {
      plain,
      sections: [{ sectionId: "evidence", heading: section, text: plain, startOffset: 0, endOffset: plain.length }],
    },
    citations,
  });
  assertCanonicalRevision(revision);
  return revision;
}

function validateExtractedCandidate(value: unknown, context: CandidatePublicationContext): CandidateWire {
  if (!isRecord(value) || !hasExactKeys(value, ["attributes", "body", "candidateKey", "citations", "entryType", "extraction", "provenance", "review", "schemaVersion", "title"])) {
    throw new CandidateProjectionError("Publishable content must be an immutable #77 extracted candidate payload.");
  }
  if (value.schemaVersion !== EXTRACTION_SCHEMA_VERSION || value.entryType !== context.entryType || value.candidateKey !== context.candidateKey) {
    throw new CandidateProjectionError("Extracted candidate schema and typed identity must match its immutable review row.");
  }
  if (!isRecord(value.provenance) || !sameBoundary(value.provenance, context.boundary)) {
    throw new CandidateProjectionError("Extracted candidate provenance must match its source, file, generation, and access boundary.");
  }
  if (!isRecord(value.extraction) || !hasExactKeys(value.extraction, ["method", "modelVersion", "parserVersion", "promptVersion"])
      || !EXTRACTION_METHODS.has(String(value.extraction.method))
      || value.extraction.parserVersion !== EXTRACTION_PARSER_VERSION || value.extraction.promptVersion !== EXTRACTION_PROMPT_VERSION
      || typeof value.extraction.modelVersion !== "string" || !value.extraction.modelVersion.trim()) {
    throw new CandidateProjectionError("Extracted candidate metadata is incomplete or unsupported.");
  }
  const reviewStatus = isRecord(value.review) ? value.review.status : undefined;
  const reviewReasons = isRecord(value.review) ? value.review.reasons : undefined;
  if (!isRecord(value.review) || !hasExactKeys(value.review, ["reasons", "status"])
      || !["ready", "ambiguous_duplicate"].includes(String(reviewStatus))
      || !Array.isArray(reviewReasons) || reviewReasons.some((reason) => typeof reason !== "string" || !reason.trim())
      || (reviewStatus === "ready" ? reviewReasons.length !== 0 : reviewReasons.length === 0)) {
    throw new CandidateProjectionError("Extracted candidate review metadata is incomplete or unsupported.");
  }
  if (!context.source.files.some((file) => file.fileId === context.boundary.fileId)) {
    throw new CandidateProjectionError("Extracted candidate file provenance is absent from the canonical source record.");
  }
  const wire = {
    entryType: value.entryType,
    candidateKey: value.candidateKey,
    title: value.title,
    body: value.body,
    attributes: value.attributes,
    citations: value.citations,
  };
  try {
    return validateCandidateWire(wire, [context.chunk]);
  } catch (error) {
    throw new CandidateProjectionError(error instanceof Error ? error.message : String(error));
  }
}

function typedField(key: string, value: unknown): Readonly<Record<string, JsonValue>> {
  const canonicalKey = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (!STABLE_ID.test(canonicalKey)) throw new CandidateProjectionError(`Attribute ${key} has no stable canonical field identity.`);
  const base = { key: canonicalKey, label: key };
  if (typeof value === "string") return { ...base, type: "string", value };
  if (typeof value === "number" && Number.isFinite(value)) return { ...base, type: "number", value };
  if (typeof value === "boolean") return { ...base, type: "boolean", value };
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return { ...base, type: "stringList", value };
  throw new CandidateProjectionError(`Attribute ${key} cannot be represented without changing its evidence semantics.`);
}

function sameBoundary(value: Record<string, unknown>, expected: ExtractionBoundary): boolean {
  return hasExactKeys(value, ["accessTier", "edition", "fileId", "generationId", "language", "ownerUserId", "shared", "sourceId"])
    && value.sourceId === expected.sourceId && value.fileId === expected.fileId && value.generationId === expected.generationId
    && value.edition === expected.edition && value.language === expected.language && value.accessTier === expected.accessTier
    && value.shared === expected.shared && value.ownerUserId === expected.ownerUserId;
}

function codeUnitOffset(value: string, codePointOffset: number): number {
  return Array.from(value).slice(0, codePointOffset).join("").length;
}

function evidenceKey(fieldPath: string): string {
  const value = fieldPath.replace(/^\$\./, "").replace(/^attributes\./, "attribute-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll(".", "-").toLowerCase();
  if (!STABLE_ID.test(value)) throw new CandidateProjectionError(`Evidence path ${fieldPath} has no stable canonical citation identity.`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
