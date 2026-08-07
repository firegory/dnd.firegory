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
import { validateSpellProjection } from "./spell-schema.ts";
import { validateCreatureProjection } from "./creature-schema.ts";
import { creatureEvidenceCitations, spellDetailEvidence, type SnapshotCreatureCandidate, type SnapshotSpellCandidate } from "./next-dnd/import-adapter.ts";
import { NEXT_DND_PARSER_VERSION } from "./next-dnd/parser.ts";

export type SnapshotSpellEvidence = Readonly<{
  sourceUrl: string;
  fingerprintSha256: string;
  rawBlobPath: string;
  fetchedAt: string;
  fileChecksumSha256: string;
  indexUrl: string;
  indexFingerprintSha256: string;
  rawIndexBlobPath: string;
  indexFetchedAt: string;
  indexCardFingerprintSha256: string;
  metadataEvidenceText: string;
}>;
export type SnapshotCollectorEvidence = SnapshotSpellEvidence;

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
  snapshotEvidence?: SnapshotSpellEvidence | null;
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
  if (isSnapshotSpellCandidate(value)) {
    try {
      validateSnapshotSpellCandidate(value, context.candidateKey, context.entryType, context.snapshotEvidence ?? null);
      return { payloadOrigin: "collector_snapshot", publicationCapability: "publishable", publicationBlockReason: null };
    } catch (error) {
      return {
        payloadOrigin: "collector_snapshot", publicationCapability: "requires_extraction",
        publicationBlockReason: `Collector spell requires review repair: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (isSnapshotCreatureCandidate(value)) {
    try {
      validateSnapshotCreatureCandidate(value, context.candidateKey, context.entryType, context.snapshotEvidence ?? null);
      return { payloadOrigin: "collector_snapshot", publicationCapability: "publishable", publicationBlockReason: null };
    } catch (error) {
      return { payloadOrigin: "collector_snapshot", publicationCapability: "requires_extraction",
        publicationBlockReason: `Collector creature requires review repair: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
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
    if (candidate.entryType === "creature") validateCreatureProjection(candidate.attributes);
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

export function projectSnapshotSpellCandidate(value: unknown, context: Readonly<{
  candidateKey: string;
  createdAt: string;
  source: ContentSource;
  fileId: string;
  evidence: SnapshotSpellEvidence;
}>): CanonicalRevision {
  const candidate = validateSnapshotSpellCandidate(value, context.candidateKey, "spell", context.evidence);
  const sourceFile = context.source.files.find((file) => file.fileId === context.fileId);
  if (!sourceFile) {
    throw new CandidateProjectionError("Collector snapshot file is absent from the canonical source record.");
  }
  if (sourceFile.contentHash !== `sha256:${context.evidence.fileChecksumSha256}`) {
    throw new CandidateProjectionError("Collector snapshot database file checksum changed across the review boundary.");
  }
  const projection = validateSpellProjection(candidate.attributes);
  const plain = candidate.body;
  const revision = createCanonicalRevision({
    schemaVersion: 1,
    kind: "canonicalRevision",
    entryId: canonicalCandidateEntryId("spell", context.candidateKey),
    createdAt: context.createdAt,
    source: context.source,
    sourceVersion: {
      url: context.evidence.sourceUrl,
      fingerprintSha256: context.evidence.fingerprintSha256,
      rawBlobPath: context.evidence.rawBlobPath,
      fetchedAt: context.evidence.fetchedAt,
      fileChecksumSha256: context.evidence.fileChecksumSha256,
      index: {
        url: context.evidence.indexUrl,
        fingerprintSha256: context.evidence.indexFingerprintSha256,
        rawBlobPath: context.evidence.rawIndexBlobPath,
        fetchedAt: context.evidence.indexFetchedAt,
        cardFingerprintSha256: context.evidence.indexCardFingerprintSha256,
        metadataEvidenceText: context.evidence.metadataEvidenceText,
      },
    },
    entry: {
      entryType: "spell",
      name: candidate.title,
      aliases: candidate.aliases,
      typedFields: Object.entries(projection).map(([key, fieldValue]) => typedField(key, fieldValue)),
    },
    text: {
      plain,
      sections: [{ sectionId: "spell-rules", heading: candidate.title, text: plain, startOffset: 0, endOffset: plain.length }],
    },
    citations: candidate.citations.map((citation) => ({
      citationId: `collector-${evidenceKey(citation.fieldPath)}`,
      sourceId: context.source.sourceId,
      fileId: context.fileId,
      page: null,
      section: citation.sourceUrl === context.evidence.indexUrl ? "window.LIST card metadata" : candidate.title,
      quote: citation.quote,
      startOffset: null,
      endOffset: null,
      fieldPath: citation.fieldPath,
      sourceUrl: citation.sourceUrl,
    })),
  });
  assertCanonicalRevision(revision);
  return revision;
}

export function projectSnapshotCreatureCandidate(value: unknown, context: Readonly<{
  candidateKey: string; createdAt: string; source: ContentSource; fileId: string; evidence: SnapshotCollectorEvidence;
}>): CanonicalRevision {
  const candidate = validateSnapshotCreatureCandidate(value, context.candidateKey, "creature", context.evidence);
  const sourceFile = context.source.files.find((file) => file.fileId === context.fileId);
  if (!sourceFile || sourceFile.contentHash !== `sha256:${context.evidence.fileChecksumSha256}`) throw new CandidateProjectionError("Collector creature database file checksum changed across the review boundary.");
  const projection = validateCreatureProjection(candidate.attributes);
  const revision = createCanonicalRevision({
    schemaVersion: 1, kind: "canonicalRevision", entryId: canonicalCandidateEntryId("creature", context.candidateKey),
    createdAt: context.createdAt, source: context.source,
    sourceVersion: { url: context.evidence.sourceUrl, fingerprintSha256: context.evidence.fingerprintSha256,
      rawBlobPath: context.evidence.rawBlobPath, fetchedAt: context.evidence.fetchedAt, fileChecksumSha256: context.evidence.fileChecksumSha256,
      index: { url: context.evidence.indexUrl, fingerprintSha256: context.evidence.indexFingerprintSha256,
        rawBlobPath: context.evidence.rawIndexBlobPath, fetchedAt: context.evidence.indexFetchedAt,
        cardFingerprintSha256: context.evidence.indexCardFingerprintSha256, metadataEvidenceText: context.evidence.metadataEvidenceText } },
    entry: { entryType: "monster", name: candidate.title, aliases: candidate.aliases,
      typedFields: Object.entries(projection).map(([key, fieldValue]) => typedField(key, fieldValue)) },
    text: { plain: candidate.body, sections: [{ sectionId: "creature-stat-block", heading: candidate.title,
      text: candidate.body, startOffset: 0, endOffset: candidate.body.length }] },
    citations: candidate.citations.map((citation) => ({ citationId: `collector-${evidenceKey(citation.fieldPath)}`,
      sourceId: context.source.sourceId, fileId: context.fileId, page: null,
      section: citation.sourceUrl === context.evidence.indexUrl ? "window.LIST bestiary card metadata" : candidate.title,
      quote: citation.quote, startOffset: null, endOffset: null, fieldPath: citation.fieldPath, sourceUrl: citation.sourceUrl })),
  });
  assertCanonicalRevision(revision);
  return revision;
}

export function projectExtractedCandidate(value: unknown, context: CandidatePublicationContext): CanonicalRevision {
  const candidate = validateExtractedCandidate(value, context);
  if (candidate.entryType === "creature") validateCreatureProjection(candidate.attributes);
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
      fieldPath: citation.fieldPath,
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

function isSnapshotSpellCandidate(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.kind === "snapshotSpellCandidate" && value.schemaVersion === 1;
}
function isSnapshotCreatureCandidate(value: unknown): value is Record<string, unknown> { return isRecord(value) && value.kind === "snapshotCreatureCandidate" && value.schemaVersion === 1; }

function validateSnapshotCreatureCandidate(value: unknown, candidateKey: string, entryType: string | null, evidence: SnapshotCollectorEvidence | null): SnapshotCreatureCandidate {
  if (!isSnapshotCreatureCandidate(value) || entryType !== "creature") throw new CandidateProjectionError("Collector candidate is not a typed creature.");
  if (!hasExactKeys(value, ["aliases", "attributes", "body", "citations", "externalId", "extraction", "kind", "parserVersion", "schemaVersion", "sha256", "sourceUrl", "sourceVersion", "title"])) throw new CandidateProjectionError("Collector creature shape is unsupported.");
  if (candidateKey !== `bestiary-${value.externalId}` || typeof value.externalId !== "string" || !/^\d+$/.test(value.externalId)) throw new CandidateProjectionError("Collector creature identity does not match its immutable review row.");
  if (typeof value.title !== "string" || !value.title.trim() || typeof value.body !== "string" || !value.body.trim()
      || !Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string" || !alias.trim())) throw new CandidateProjectionError("Collector creature title, aliases, or body are invalid.");
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.sourceUrl !== "string" || !/^https:\/\/next\.dnd\.su\//.test(value.sourceUrl)
      || !isRecord(value.sourceVersion) || value.sourceVersion.url !== value.sourceUrl || value.sourceVersion.sha256 !== value.sha256
      || value.sourceVersion.rawBlobPath !== `blobs/${value.sha256}.html` || typeof value.sourceVersion.fetchedAt !== "string") throw new CandidateProjectionError("Collector creature source version is invalid.");
  if (!evidence || value.sourceUrl !== evidence.sourceUrl || value.sha256 !== evidence.fingerprintSha256
      || value.sourceVersion.rawBlobPath !== evidence.rawBlobPath || value.sourceVersion.fetchedAt !== evidence.fetchedAt
      || value.parserVersion !== NEXT_DND_PARSER_VERSION || !isRecord(value.sourceVersion.index)
      || value.sourceVersion.index.url !== evidence.indexUrl || value.sourceVersion.index.sha256 !== evidence.indexFingerprintSha256
      || value.sourceVersion.index.rawBlobPath !== evidence.rawIndexBlobPath || value.sourceVersion.index.fetchedAt !== evidence.indexFetchedAt
      || value.sourceVersion.index.cardFingerprintSha256 !== evidence.indexCardFingerprintSha256
      || value.sourceVersion.index.metadataEvidenceText !== evidence.metadataEvidenceText) throw new CandidateProjectionError("Collector creature provenance does not match persisted immutable evidence.");
  if (!isRecord(value.extraction) || value.extraction.status !== "ready" || !Array.isArray(value.extraction.missingFields) || value.extraction.missingFields.length) throw new CandidateProjectionError("Typed collector creature extraction is incomplete.");
  const projection = validateCreatureProjection(value.attributes);
  let expectedCitations;
  try { expectedCitations = [{ fieldPath: "$.title", quote: value.title, sourceUrl: evidence.sourceUrl }, { fieldPath: "$.body", quote: value.body, sourceUrl: evidence.sourceUrl },
    ...creatureEvidenceCitations(projection, value.body, evidence.metadataEvidenceText, evidence.sourceUrl, evidence.indexUrl)]; }
  catch (error) { throw new CandidateProjectionError(error instanceof Error ? error.message : String(error)); }
  if (!Array.isArray(value.citations) || JSON.stringify(value.citations) !== JSON.stringify(expectedCitations)) throw new CandidateProjectionError("Collector creature values and citations must exactly match immutable detail and metadata evidence.");
  return value as unknown as SnapshotCreatureCandidate;
}

function validateSnapshotSpellCandidate(value: unknown, candidateKey: string, entryType: string | null, evidence: SnapshotSpellEvidence | null): SnapshotSpellCandidate {
  if (!isSnapshotSpellCandidate(value) || entryType !== "spell") throw new CandidateProjectionError("Collector candidate is not a typed spell.");
  if (!hasExactKeys(value, ["aliases", "attributes", "body", "citations", "externalId", "extraction", "kind", "parserVersion", "schemaVersion", "sha256", "sourceUrl", "sourceVersion", "title"])) {
    throw new CandidateProjectionError("Collector spell shape is unsupported.");
  }
  if (candidateKey !== `spells-${value.externalId}` || typeof value.externalId !== "string" || !/^\d+$/.test(value.externalId)) {
    throw new CandidateProjectionError("Collector spell identity does not match its immutable review row.");
  }
  if (typeof value.title !== "string" || !value.title.trim() || typeof value.body !== "string" || !value.body.trim()) {
    throw new CandidateProjectionError("Collector spell title and body are required.");
  }
  if (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
    throw new CandidateProjectionError("Collector spell aliases are invalid.");
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)
      || typeof value.sourceUrl !== "string" || !/^https:\/\/next\.dnd\.su\//.test(value.sourceUrl)) {
    throw new CandidateProjectionError("Collector spell source identity is invalid.");
  }
  if (!isRecord(value.sourceVersion) || value.sourceVersion.url !== value.sourceUrl || value.sourceVersion.sha256 !== value.sha256
      || value.sourceVersion.rawBlobPath !== `blobs/${value.sha256}.html`
      || typeof value.sourceVersion.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.sourceVersion.fetchedAt))) {
    throw new CandidateProjectionError("Collector spell source version is invalid.");
  }
  if (!evidence || value.sourceUrl !== evidence.sourceUrl || value.sha256 !== evidence.fingerprintSha256
      || value.sourceVersion.url !== evidence.sourceUrl || value.sourceVersion.sha256 !== evidence.fingerprintSha256
      || value.sourceVersion.rawBlobPath !== evidence.rawBlobPath || value.sourceVersion.fetchedAt !== evidence.fetchedAt) {
    throw new CandidateProjectionError("Collector spell provenance does not match its persisted occurrence and raw blob evidence.");
  }
  if (value.parserVersion !== NEXT_DND_PARSER_VERSION || !/^[0-9a-f]{64}$/.test(evidence.fileChecksumSha256)) {
    throw new CandidateProjectionError("Collector spell parser or database file evidence is unsupported.");
  }
  if (!isRecord(value.extraction) || value.extraction.status !== "ready" || !Array.isArray(value.extraction.missingFields)
      || value.extraction.missingFields.length !== 0) {
    throw new CandidateProjectionError("Typed collector extraction is incomplete.");
  }
  const projection = validateSpellProjection(value.attributes);
  if (!isRecord(value.sourceVersion.index)
      || !hasExactKeys(value.sourceVersion.index, ["cardFingerprintSha256", "fetchedAt", "metadataEvidenceText", "rawBlobPath", "sha256", "url"])
      || value.sourceVersion.index.url !== evidence.indexUrl
      || value.sourceVersion.index.sha256 !== evidence.indexFingerprintSha256
      || value.sourceVersion.index.rawBlobPath !== evidence.rawIndexBlobPath
      || value.sourceVersion.index.fetchedAt !== evidence.indexFetchedAt
      || value.sourceVersion.index.cardFingerprintSha256 !== evidence.indexCardFingerprintSha256
      || value.sourceVersion.index.metadataEvidenceText !== evidence.metadataEvidenceText
      || value.sourceVersion.index.rawBlobPath !== `blobs/${value.sourceVersion.index.sha256}.html`) {
    throw new CandidateProjectionError("Collector spell index card evidence does not match its persisted occurrence envelope.");
  }
  const metadata = parseSpellMetadataEvidence(evidence.metadataEvidenceText);
  const expectedPaths = new Set(["$.title", "$.body", ...Object.keys(projection).map((field) => `$.attributes.${field}`)]);
  if (!Array.isArray(value.citations) || value.citations.length !== expectedPaths.size) {
    throw new CandidateProjectionError("Collector spell requires one citation for every canonical field.");
  }
  for (const citation of value.citations) {
    if (!isRecord(citation) || typeof citation.fieldPath !== "string" || !expectedPaths.delete(citation.fieldPath)
        || ![evidence.sourceUrl, evidence.indexUrl].includes(String(citation.sourceUrl))
        || typeof citation.quote !== "string" || !citation.quote.trim()) {
      throw new CandidateProjectionError("Collector spell field citations do not match immutable snapshot evidence.");
    }
    validateSnapshotCitation(citation, value, projection, metadata, evidence);
  }
  return value as unknown as SnapshotSpellCandidate;
}

type SpellMetadataEvidence = Readonly<{
  level: number | null;
  school: string | null;
  ritual: boolean;
  concentration: boolean;
  classes: readonly string[];
}>;

function parseSpellMetadataEvidence(text: string): SpellMetadataEvidence {
  const lines = text.split("\n");
  if (lines.shift() !== "window.LIST card metadata") throw new CandidateProjectionError("Collector spell metadata evidence heading is invalid.");
  const expected = ["level", "school", "ritual", "concentration", "classes"];
  const values: Record<string, unknown> = {};
  for (const key of expected) {
    const line = lines.shift();
    if (!line?.startsWith(`${key}=`)) throw new CandidateProjectionError(`Collector spell metadata evidence is missing ${key}.`);
    try { values[key] = JSON.parse(line.slice(key.length + 1)); }
    catch { throw new CandidateProjectionError(`Collector spell metadata evidence ${key} is invalid JSON.`); }
  }
  if (lines.length !== 0 || (values.level !== null && !Number.isInteger(values.level))
      || (values.school !== null && typeof values.school !== "string") || typeof values.ritual !== "boolean"
      || typeof values.concentration !== "boolean" || !Array.isArray(values.classes)
      || values.classes.some((item) => typeof item !== "string")) {
    throw new CandidateProjectionError("Collector spell metadata evidence shape is invalid.");
  }
  return values as SpellMetadataEvidence;
}

function validateSnapshotCitation(
  citation: Record<string, unknown>,
  candidate: Record<string, unknown>,
  projection: ReturnType<typeof validateSpellProjection>,
  metadata: SpellMetadataEvidence,
  evidence: SnapshotSpellEvidence,
): void {
  const path = String(citation.fieldPath);
  const quote = String(citation.quote);
  const sourceUrl = String(citation.sourceUrl);
  if (path === "$.title" || path === "$.body") {
    const expected = path === "$.title" ? candidate.title : candidate.body;
    if (sourceUrl !== evidence.sourceUrl || quote !== expected) {
      throw new CandidateProjectionError("Collector spell detail citation is not exact immutable detail evidence.");
    }
    return;
  }
  const field = path.slice("$.attributes.".length) as keyof typeof projection;
  const value = projection[field];
  if (["castingTime", "range", "duration", "components"].includes(field)) {
    const detailValue = spellDetailEvidence(String(candidate.body))[field as "castingTime" | "range" | "duration" | "components"];
    if (sourceUrl !== evidence.sourceUrl || quote !== value || value !== detailValue) {
      throw new CandidateProjectionError(`Collector spell ${field} citation is not its exact detail value.`);
    }
    return;
  }
  if (field === "concentration" && sourceUrl === evidence.sourceUrl) {
    if (value !== true || quote !== projection.duration || !String(candidate.body).includes(quote)) {
      throw new CandidateProjectionError("Collector spell concentration is not supported by exact detail duration evidence.");
    }
    return;
  }
  const metadataValue = field === "school" ? normalizedSchool(metadata.school) : metadata[field as keyof SpellMetadataEvidence];
  const expectedQuote = field === "school" ? JSON.stringify(metadata.school) : JSON.stringify(metadata[field as keyof SpellMetadataEvidence]);
  if (sourceUrl !== evidence.indexUrl || JSON.stringify(value) !== JSON.stringify(metadataValue)
      || quote !== expectedQuote || !evidence.metadataEvidenceText.includes(`${field}=${quote}`)) {
    throw new CandidateProjectionError(`Collector spell ${field} is not supported by exact immutable index card evidence.`);
  }
}

function normalizedSchool(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase("und");
  const aliases: Record<string, string> = {
    ограждение: "abjuration", вызов: "conjuration", прорицание: "divination", очарование: "enchantment",
    воплощение: "evocation", иллюзия: "illusion", некромантия: "necromancy", преобразование: "transmutation",
  };
  return aliases[normalized] ?? normalized;
}

function typedField(key: string, value: unknown): Readonly<Record<string, JsonValue>> {
  const canonicalKey = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (!STABLE_ID.test(canonicalKey)) throw new CandidateProjectionError(`Attribute ${key} has no stable canonical field identity.`);
  const base = { key: canonicalKey, label: key };
  if (typeof value === "string") return { ...base, type: "string", value };
  if (typeof value === "number" && Number.isFinite(value)) return { ...base, type: "number", value };
  if (typeof value === "boolean") return { ...base, type: "boolean", value };
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return { ...base, type: "stringList", value };
  if (value !== null && typeof value === "object") return { ...base, type: "json", value: value as JsonValue };
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
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/\[([0-9]+)\]/g, "-$1").replaceAll(".", "-").toLowerCase();
  if (!STABLE_ID.test(value)) throw new CandidateProjectionError(`Evidence path ${fieldPath} has no stable canonical citation identity.`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
