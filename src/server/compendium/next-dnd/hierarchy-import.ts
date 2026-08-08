import { collectorCanonicalEntryId } from "../identity.ts";
import { validateClassProjection, validateSpeciesProjection, type ClassProjection, type SpeciesProjection } from "../hierarchy-schema.ts";
import type { SnapshotDetail } from "./collector.ts";

export type SnapshotHierarchyCandidate = Readonly<{
  schemaVersion: 1;
  kind: "snapshotHierarchyCandidate";
  entryType: "class" | "species";
  externalId: string;
  sourceUrl: string;
  sha256: string;
  parserVersion: string;
  title: string;
  aliases: readonly string[];
  body: string;
  attributes: ClassProjection | SpeciesProjection;
  sourceVersion: Readonly<{
    url: string; sha256: string; rawBlobPath: string; fetchedAt: string;
    index: Readonly<{ url: string; sha256: string; rawBlobPath: string; fetchedAt: string; cardFingerprintSha256: string; metadataEvidenceText: string }>;
  }>;
  citations: readonly Readonly<{ fieldPath: string; quote: string; sourceUrl: string }>[];
  extraction: Readonly<{ status: "ready"; missingFields: readonly [] }>;
}>;

export type SnapshotFeatureCandidate = Readonly<{
  schemaVersion: 1; kind: "snapshotFeatureCandidate"; entryType: "feature"; externalId: string; canonicalId: string;
  classCandidateKey: string; sourceUrl: string; sha256: string; parserVersion: string; title: string; aliases: readonly string[];
  body: string; attributes: Readonly<{ level: number; featureKind: "class"; anchor: string }>;
  sourceVersion: SnapshotHierarchyCandidate["sourceVersion"];
  citations: readonly Readonly<{ fieldPath: string; quote: string; sourceUrl: string }>[];
  extraction: Readonly<{ status: "ready"; missingFields: readonly [] }>;
}>;

/** Deterministically maps collector metadata; no HTML or inferred rules enter review. */
export function hierarchyCandidate(detail: SnapshotDetail): SnapshotHierarchyCandidate {
  if (detail.category !== "class" && detail.category !== "species") throw new Error("Hierarchy projection only accepts class and species details.");
  const metadata = detail.indexMetadata;
  const attributes = detail.category === "class" ? classAttributes(metadata) : speciesAttributes(metadata);
  const metadataEvidenceText = hierarchyMetadataEvidence(attributes);
  const aliases = typeof metadata.title_en === "string" && metadata.title_en.trim() ? [metadata.title_en.trim()] : [];
  return {
    schemaVersion: 1, kind: "snapshotHierarchyCandidate", entryType: detail.category, externalId: detail.externalId,
    sourceUrl: detail.sourceUrl, sha256: detail.sha256, parserVersion: detail.parserVersion,
    title: detail.normalized.title, aliases, body: detail.normalized.contentText, attributes,
    sourceVersion: { url: detail.sourceUrl, sha256: detail.sha256, rawBlobPath: detail.blobPath, fetchedAt: detail.fetchedAt,
      index: { url: detail.indexSource.url, sha256: detail.indexSource.fingerprintSha256, rawBlobPath: detail.indexSource.rawBlobPath,
        fetchedAt: detail.indexSource.fetchedAt, cardFingerprintSha256: detail.indexSource.cardFingerprintSha256, metadataEvidenceText } },
    citations: [
      { fieldPath: "$.title", quote: detail.normalized.title, sourceUrl: detail.sourceUrl },
      { fieldPath: "$.body", quote: detail.normalized.contentText, sourceUrl: detail.sourceUrl },
      ...Object.entries(attributes).map(([key, value]) => ({ fieldPath: `$.attributes.${key}`, quote: JSON.stringify(value), sourceUrl: detail.indexSource.url })),
    ], extraction: { status: "ready", missingFields: [] },
  };
}

export function hierarchyMetadataEvidence(attributes: ClassProjection | SpeciesProjection): string {
  return ["window.LIST hierarchy metadata", ...Object.entries(attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`)].join("\n");
}

export function featureCandidates(detail: SnapshotDetail): readonly SnapshotFeatureCandidate[] {
  if (detail.category !== "class") throw new Error("Feature projection requires a class detail.");
  const hierarchy = hierarchyCandidate(detail);
  const attributes = hierarchy.attributes as ClassProjection;
  return attributes.features.map((feature) => {
    const externalId = feature.canonicalId.slice("feature-".length);
    const typed = { level: feature.level, featureKind: "class" as const, anchor: feature.anchor };
    return {
      schemaVersion: 1, kind: "snapshotFeatureCandidate", entryType: "feature", externalId, canonicalId: feature.canonicalId,
      classCandidateKey: collectorCanonicalEntryId("class", detail.externalId), sourceUrl: detail.sourceUrl, sha256: detail.sha256,
      parserVersion: detail.parserVersion, title: feature.title, aliases: [], body: feature.body, attributes: typed,
      sourceVersion: hierarchy.sourceVersion,
      citations: [
        { fieldPath: "$.title", quote: feature.title, sourceUrl: detail.indexSource.url },
        { fieldPath: "$.body", quote: feature.body, sourceUrl: detail.indexSource.url },
        ...Object.entries(typed).map(([key, value]) => ({ fieldPath: `$.attributes.${key}`, quote: JSON.stringify(value), sourceUrl: detail.indexSource.url })),
      ], extraction: { status: "ready", missingFields: [] },
    };
  });
}

function classAttributes(metadata: Readonly<Record<string, unknown>>): ClassProjection {
  const rawParents=metadata.parentClassIds??metadata.parent_class_ids;
  const kind = metadata.kind === "subclass" || (Array.isArray(rawParents) ? rawParents.length > 0 : rawParents != null) ? "subclass" : "class";
  return validateClassProjection({
    kind, hitDie: die(metadata.hitDie ?? metadata.hit_die), primaryAbility: required(metadata.primaryAbility ?? metadata.primary_ability, "primary ability"),
    spellcastingAbility: optional(metadata.spellcastingAbility ?? metadata.spellcasting_ability),
    parentClassIds: canonicalIds(rawParents, "class"),
    progressionColumns: metadata.progressionColumns ?? metadata.progression_columns ?? [],
    progressionRows: metadata.progressionRows ?? metadata.progression_rows ?? [], features: metadata.features ?? [],
    crossLinks: canonicalIds(metadata.crossLinks ?? metadata.cross_links, undefined),
  });
}

function speciesAttributes(metadata: Readonly<Record<string, unknown>>): SpeciesProjection {
  const parents = canonicalIds(metadata.parentSpeciesIds ?? metadata.parent_species_ids, "species");
  return validateSpeciesProjection({ kind: metadata.kind === "variant" || parents.length ? "variant" : "species",
    size: String(metadata.size ?? "medium").toLocaleLowerCase("und"), speed: Number(metadata.speed), parentSpeciesIds: parents,
    traits: metadata.traits ?? [], crossLinks: canonicalIds(metadata.crossLinks ?? metadata.cross_links, undefined) });
}

function canonicalIds(value: unknown, type: "class" | "species" | undefined): string[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const text = String(item).normalize("NFC").trim();
    if (/^(?:class|species|feature)-/.test(text)) return text;
    if (!type) throw new Error(`Cross-link ${text} must use a canonical type-qualified ID.`);
    return collectorCanonicalEntryId(type, text);
  });
}
function die(value: unknown): number { const match = String(value).match(/(?:d)?(6|8|10|12)/i); if (!match) throw new Error("Class hit die is missing."); return Number(match[1]); }
function required(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`Class ${field} is missing.`); return value.trim(); }
function optional(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
