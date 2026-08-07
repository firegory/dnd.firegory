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

export type CandidatePublicationCapability = Readonly<{
  payloadOrigin: "pdf_extraction" | "collector_snapshot" | "unknown";
  publicationCapability: "publishable" | "can_unpublish" | "requires_extraction";
  publicationBlockReason: string | null;
}>;

export type CandidateCapabilityContext = Readonly<{
  candidateKey: string;
  entryType: string | null;
  sourceId: string;
  fileId: string;
  generationId: string | null;
  edition: unknown;
  language: unknown;
  accessTier: unknown;
  shared: unknown;
  ownerUserId: unknown;
  chunk: EvidenceChunk | null;
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

export function classifyCandidatePublication(value: unknown, context: CandidateCapabilityContext): CandidatePublicationCapability {
  if (isCollectorSnapshotCandidate(value) || isStaticGuideReviewCandidate(value)) {
    return {
      payloadOrigin: "collector_snapshot",
      publicationCapability: "requires_extraction",
      publicationBlockReason: "Collector snapshot candidates require chunk-backed canonical extraction before publication.",
    };
  }
  if (!isExtractionEnvelope(value)) {
    return {
      payloadOrigin: "unknown",
      publicationCapability: "requires_extraction",
      publicationBlockReason: "Candidate payload origin is unsupported and requires canonical extraction before publication.",
    };
  }
  try {
    if (!context.entryType || !context.generationId || !context.chunk) {
      throw new CandidateProjectionError("Extraction candidate is missing generation or chunk evidence.");
    }
    const boundary: ExtractionBoundary = {
      sourceId: context.sourceId,
      fileId: context.fileId,
      generationId: context.generationId,
      edition: context.edition as ExtractionBoundary["edition"],
      language: context.language as ExtractionBoundary["language"],
      accessTier: context.accessTier as ExtractionBoundary["accessTier"],
      shared: context.shared as boolean,
      ownerUserId: context.ownerUserId as string | null,
    };
    const candidate = validateExtractionEnvelope(value, context.candidateKey, context.entryType as CompendiumEntryType, boundary, context.chunk);
    Object.entries(candidate.attributes).forEach(([attribute, fieldValue]) => typedField(attribute, fieldValue));
    if (context.chunk.pageNumber === null) throw new CandidateProjectionError("Extraction candidate has no source page.");
    return { payloadOrigin: "pdf_extraction", publicationCapability: "publishable", publicationBlockReason: null };
  } catch (error) {
    return {
      payloadOrigin: "pdf_extraction",
      publicationCapability: "requires_extraction",
      publicationBlockReason: `Extraction candidate requires repair before publication: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isStaticGuideReviewCandidate(value: unknown): boolean {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "staticGuideReviewCandidate"
    && typeof value.slug === "string"
    && (value.locale === "ru" || value.locale === "en")
    && isRecord(value.source)
    && Array.isArray(value.blocks)
    && value.blocks.length > 0
    && isRecord(value.review)
    && value.review.workflow === "#76"
    && value.review.status === "pending"
    && !("contentHtml" in value);
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
  const candidate = validateExtractionEnvelope(value, context.candidateKey, context.entryType, context.boundary, context.chunk);
  if (!context.source.files.some((file) => file.fileId === context.boundary.fileId)) {
    throw new CandidateProjectionError("Extracted candidate file provenance is absent from the canonical source record.");
  }
  return candidate;
}

function validateExtractionEnvelope(value: unknown, candidateKey: string, entryType: CompendiumEntryType, boundary: ExtractionBoundary, chunk: EvidenceChunk): CandidateWire {
  if (!isExtractionEnvelope(value)) {
    throw new CandidateProjectionError("Publishable content must be an immutable #77 extracted candidate payload.");
  }
  if (value.schemaVersion !== EXTRACTION_SCHEMA_VERSION || value.entryType !== entryType || value.candidateKey !== candidateKey) {
    throw new CandidateProjectionError("Extracted candidate schema and typed identity must match its immutable review row.");
  }
  if (!validBoundary(boundary) || !isRecord(value.provenance) || !sameBoundary(value.provenance, boundary)) {
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
  const wire = {
    entryType: value.entryType,
    candidateKey: value.candidateKey,
    title: value.title,
    body: value.body,
    attributes: value.attributes,
    citations: value.citations,
  };
  try {
    return validateCandidateWire(wire, [chunk]);
  } catch (error) {
    throw new CandidateProjectionError(error instanceof Error ? error.message : String(error));
  }
}

function validBoundary(boundary: ExtractionBoundary): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validAccess = (boundary.accessTier === "open" && !boundary.shared && boundary.ownerUserId === null)
    || (boundary.accessTier === "premium" && boundary.shared && boundary.ownerUserId === null)
    || (boundary.accessTier === "personal" && !boundary.shared && typeof boundary.ownerUserId === "string" && uuid.test(boundary.ownerUserId));
  return uuid.test(boundary.sourceId) && uuid.test(boundary.fileId) && uuid.test(boundary.generationId)
    && ["5e", "5.5e"].includes(boundary.edition) && ["en", "ru"].includes(boundary.language) && validAccess;
}

function isExtractionEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, ["attributes", "body", "candidateKey", "citations", "entryType", "extraction", "provenance", "review", "schemaVersion", "title"]);
}

function isCollectorSnapshotCandidate(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["contentHtml", "contentText", "externalId", "indexMetadata", "parserVersion", "sha256", "sourceUrl", "title"])
    && typeof value.externalId === "string" && Boolean(value.externalId.trim())
    && typeof value.sourceUrl === "string" && /^https:\/\//.test(value.sourceUrl)
    && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)
    && typeof value.parserVersion === "string" && Boolean(value.parserVersion.trim())
    && typeof value.title === "string" && Boolean(value.title.trim())
    && typeof value.contentHtml === "string" && typeof value.contentText === "string"
    && isRecord(value.indexMetadata);
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
