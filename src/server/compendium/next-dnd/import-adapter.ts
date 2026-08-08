import type { CompendiumImportRunService, ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";
import { NEXT_DND_CATEGORIES, nextDndCardFingerprint } from "./parser.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "./collector.ts";
import { SPELL_SCHOOLS, type SpellSchool } from "../spell-schema.ts";
import { canonicalFlatAttributes, FLAT_ENTRY_TYPES, projectionAttributes, validateFlatProjection, type FlatEntryType, type FlatProjection } from "../flat-schema.ts";
import { parseMoneyToCp, parseWeights } from "../candidate-schema.ts";

type ImportRunAdapterTarget = Pick<CompendiumImportRunService, "addDiagnostic" | "failRun" | "recordOccurrences" | "computeCandidateDiff">;

export function nextDndImportBatch(manifest: NextDndSnapshotManifest): Readonly<{
  occurrences: readonly ImportOccurrenceInput[];
  candidates: readonly ImportCandidateInput[];
}> {
  if (!isCompleteManifest(manifest)) throw new Error("An incomplete next.dnd.su manifest cannot produce import candidates.");
  const details = manifest.categories.flatMap((category) => category.details);
  return {
    occurrences: details.map((detail, occurrenceIndex) => ({
      occurrenceIndex,
      locator: detail.sourceUrl,
      fingerprintSha256: detail.sha256,
      rawBlobPath: detail.blobPath,
      sourceFetchedAt: detail.fetchedAt,
      indexLocator: detail.indexSource.url,
      indexFingerprintSha256: detail.indexSource.fingerprintSha256,
      rawIndexBlobPath: detail.indexSource.rawBlobPath,
      indexSourceFetchedAt: detail.indexSource.fetchedAt,
      indexCardFingerprintSha256: detail.indexSource.cardFingerprintSha256,
      metadataEvidenceText: detail.category === "spells" ? spellMetadataEvidence(detail.indexMetadata)
        : isFlatCategory(detail.category) ? flatMetadataEvidence(projectionAttributes(flatProjection(detail))) : null,
    })),
    candidates: details.map((detail, occurrenceIndex) => candidate(detail, occurrenceIndex)),
  };
}

export async function feedNextDndSnapshotToImportRun(
  target: ImportRunAdapterTarget,
  runId: string,
  leaseToken: string,
  manifest: NextDndSnapshotManifest,
  actor: string,
): Promise<void> {
  if (!isCompleteManifest(manifest)) {
    await target.addDiagnostic(runId, leaseToken, {
      diagnosticKey: "next-dnd-incomplete-snapshot",
      level: "error",
      code: "next_dnd_incomplete_snapshot",
      message: "The next.dnd.su snapshot is incomplete; candidate diffing was not started.",
      details: {
        manifestStatus: manifest.status,
        parserFailureCount: manifest.parserFailures.length,
        incompleteCategories: manifest.categories.filter((category) => category.index === null || category.details.length !== category.entryCount).map((category) => category.requestedCategory),
      },
      actor,
    });
    await target.failRun(runId, leaseToken, actor, "The next.dnd.su snapshot is incomplete.");
    return;
  }
  for (const [index, diagnostic] of manifest.diagnostics.entries()) {
    await target.addDiagnostic(runId, leaseToken, {
      diagnosticKey: `next-dnd-collection-${index}`,
      level: "warning",
      code: diagnostic.code.replaceAll("-", "_"),
      message: diagnostic.message,
      details: { sourceUrl: diagnostic.sourceUrl, attempts: diagnostic.attempts },
      actor,
    });
  }
  const batch = nextDndImportBatch(manifest);
  await target.recordOccurrences(runId, leaseToken, batch.occurrences, actor);
  await target.computeCandidateDiff(runId, leaseToken, batch.candidates, actor);
}

function isCompleteManifest(manifest: NextDndSnapshotManifest): boolean {
  return manifest.status === "complete"
    && manifest.robots !== null
    && manifest.parserFailures.length === 0
    && manifest.categories.length > 0
    && manifest.categories.every((category) => category.index !== null && category.details.length === category.entryCount);
}

function candidate(detail: SnapshotDetail, occurrenceIndex: number): ImportCandidateInput {
  return {
    occurrenceIndex,
    candidateKey: `${detail.category}-${detail.externalId}`,
    entryType: NEXT_DND_CATEGORIES[detail.category].entryType,
    content: detail.category === "spells" ? spellCandidate(detail) : isFlatCategory(detail.category) ? flatCandidate(detail) : {
      externalId: detail.externalId,
      sourceUrl: detail.sourceUrl,
      sha256: detail.sha256,
      parserVersion: detail.parserVersion,
      title: detail.normalized.title,
      contentHtml: detail.normalized.contentHtml,
      contentText: detail.normalized.contentText,
      indexMetadata: detail.indexMetadata,
    },
  };
}

export type SnapshotFlatCandidate = Readonly<{
  schemaVersion: 1;
  kind: "snapshotFlatCandidate";
  entryType: FlatEntryType;
  externalId: string;
  sourceUrl: string;
  sha256: string;
  parserVersion: string;
  title: string;
  aliases: readonly string[];
  body: string;
  attributes: Readonly<Record<string, unknown>>;
  sourceVersion: SnapshotSpellCandidate["sourceVersion"];
  citations: readonly Readonly<{ fieldPath: string; quote: string; sourceUrl: string }>[];
  extraction: Readonly<{ status: "ready"; missingFields: readonly [] }>;
}>;

/** Converts a collector snapshot into typed review input; review publication revalidates persisted evidence. */
export function flatCandidate(detail: SnapshotDetail): SnapshotFlatCandidate {
  if (!isFlatCategory(detail.category)) throw new Error("Snapshot flat projection only accepts flat compendium details.");
  if (nextDndCardFingerprint(detail.indexMetadata) !== detail.indexSource.cardFingerprintSha256) {
    throw new Error("Snapshot flat metadata does not match the exact collected window.LIST card fingerprint.");
  }
  const projection = flatProjection(detail);
  const attributes = canonicalFlatAttributes(projection.type, projection);
  const metadataEvidenceText = flatMetadataEvidence(attributes);
  const aliases = typeof detail.indexMetadata.title_en === "string" && detail.indexMetadata.title_en.trim()
    ? [detail.indexMetadata.title_en.normalize("NFC").trim()] : [];
  return {
    schemaVersion: 1, kind: "snapshotFlatCandidate", entryType: projection.type,
    externalId: detail.externalId, sourceUrl: detail.sourceUrl, sha256: detail.sha256,
    parserVersion: detail.parserVersion, title: detail.normalized.title, aliases,
    body: detail.normalized.contentText, attributes,
    sourceVersion: {
      url: detail.sourceUrl, sha256: detail.sha256, rawBlobPath: detail.blobPath, fetchedAt: detail.fetchedAt,
      index: {
        url: detail.indexSource.url, sha256: detail.indexSource.fingerprintSha256,
        rawBlobPath: detail.indexSource.rawBlobPath, fetchedAt: detail.indexSource.fetchedAt,
        cardFingerprintSha256: detail.indexSource.cardFingerprintSha256, metadataEvidenceText,
      },
    },
    citations: [
      { fieldPath: "$.title", quote: detail.normalized.title, sourceUrl: detail.sourceUrl },
      { fieldPath: "$.body", quote: detail.normalized.contentText, sourceUrl: detail.sourceUrl },
      ...Object.entries(attributes).map(([name, value]) => ({
        fieldPath: `$.attributes.${name}`, quote: JSON.stringify(value), sourceUrl: detail.indexSource.url,
      })),
    ],
    extraction: { status: "ready", missingFields: [] },
  };
}

export function flatMetadataEvidence(attributes: Readonly<Record<string, unknown>>): string {
  return ["window.LIST flat projection", ...Object.entries(attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`)].join("\n");
}

function flatProjection(detail: SnapshotDetail): FlatProjection {
  const metadata = detail.indexMetadata;
  const explicit = record(metadata.typed_fields ?? metadata.attributes);
  const explicitValue = (...keys: readonly string[]) => {
    const key = keys.find((candidate) => Object.hasOwn(explicit, candidate));
    return key ? { present: true, value: explicit[key] } : { present: false, value: keys.map((candidate) => metadata[candidate]).find((item) => item !== undefined) };
  };
  const value = (...keys: readonly string[]) => explicitValue(...keys).value;
  const labelled = (labels: readonly string[]) => labelledValue(detail.normalized.contentText, labels);
  const type = NEXT_DND_CATEGORIES[detail.category].entryType as FlatEntryType;
  if (type === "feat") return validateFlatProjection(type, {
    category: normalizedEnum(value("category") ?? metadata.item_prefix_title, {
      origin: "origin", general: "general", "fighting style": "fighting_style", fighting_style: "fighting_style", "epic boon": "epic_boon", epic_boon: "epic_boon",
      происхождение: "origin", общая: "general", "боевой стиль": "fighting_style", "эпический дар": "epic_boon",
    }, "general"),
    prerequisiteLevel: integer(value("prerequisiteLevel", "prerequisite_level"), 1, 20),
    prerequisiteText: nullableString(explicitValue("prerequisiteText", "prerequisite_text").present ? value("prerequisiteText", "prerequisite_text") : labelled(["Prerequisite", "Требование"])),
    repeatable: Boolean(value("repeatable")) || /(?:repeatable|повторяем)/iu.test(detail.normalized.contentText),
  });
  if (type === "background") return validateFlatProjection(type, {
    abilityScores: stringList(value("abilityScores", "ability_scores") ?? labelled(["Ability Scores", "Характеристики"])),
    skillProficiencies: stringList(value("skillProficiencies", "skill_proficiencies") ?? labelled(["Skill Proficiencies", "Владение навыками"])),
  });
  if (type === "item") return validateFlatProjection(type, {
    category: normalizedEnum(value("category") ?? metadata.item_icon_title, Object.fromEntries(["armor", "potion", "ring", "rod", "scroll", "staff", "wand", "weapon", "wondrous", "other"].map((key) => [key, key])), "other"),
    rarity: normalizedEnum(value("rarity") ?? metadata.item_prefix_title, { common: "common", uncommon: "uncommon", rare: "rare", "very rare": "very_rare", very_rare: "very_rare", legendary: "legendary", artifact: "artifact", varies: "varies" }, "varies"),
    requiresAttunement: Boolean(value("requiresAttunement") ?? value("requires_attunement")) || /(?:requires attunement|требует настройк)/iu.test(detail.normalized.contentText),
  });
  if (type === "equipment") return validateFlatProjection(type, {
    category: normalizedEnum(value("category") ?? metadata.item_prefix_title, {
      "adventuring gear": "adventuring_gear", adventuring_gear: "adventuring_gear", ammunition: "ammunition", armor: "armor", focus: "focus", mount: "mount", tool: "tool", vehicle: "vehicle", weapon: "weapon", other: "other",
      снаряжение: "adventuring_gear", боеприпасы: "ammunition", доспехи: "armor", фокусировка: "focus", транспорт: "vehicle", оружие: "weapon",
    }, "other"),
    costCp: explicitValue("costCp", "cost_cp").present ? integer(value("costCp", "cost_cp"), 0, 2_147_483_647) : parseMoneyToCp(String(value("cost") ?? labelled(["Cost", "Стоимость", "Цена"]) ?? ""))[0] ?? null,
    weightLb: explicitValue("weightLb", "weight_lb").present ? finiteNumber(value("weightLb", "weight_lb")) : parseWeights(String(value("weight") ?? labelled(["Weight", "Вес"]) ?? ""))[0] ?? null,
  });
  return validateFlatProjection("glossary", {
    category: nullableString(value("category") ?? metadata.item_prefix_title) ?? "rules",
    relatedTerms: stringValues(value("relatedTerms") ?? value("related_terms")),
  });
}

function isFlatCategory(category: string): category is "feats" | "backgrounds" | "items" | "equipment" | "glossary" {
  return category in NEXT_DND_CATEGORIES && FLAT_ENTRY_TYPES.includes(NEXT_DND_CATEGORIES[category as keyof typeof NEXT_DND_CATEGORIES].entryType as FlatEntryType);
}
function normalizedEnum(value: unknown, aliases: Readonly<Record<string, string>>, fallback: string): string { const key = String(value ?? "").normalize("NFC").trim().toLocaleLowerCase("und"); return aliases[key] ?? fallback; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.normalize("NFC").trim() : null; }
function finiteNumber(value: unknown): number | null { const number = typeof value === "number" ? value : Number.NaN; return Number.isFinite(number) ? number : null; }
function stringList(value: unknown): readonly string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/u) : [];
  return [...new Set(items.map((item) => String(item).normalize("NFC").trim()).filter(Boolean))];
}
function stringValues(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.normalize("NFC").trim()) : []; }

export type SnapshotSpellCandidate = Readonly<{
  schemaVersion: 1;
  kind: "snapshotSpellCandidate";
  externalId: string;
  sourceUrl: string;
  sha256: string;
  parserVersion: string;
  title: string;
  aliases: readonly string[];
  body: string;
  attributes: Readonly<{
    level: number | null;
    school: SpellSchool | null;
    castingTime: string | null;
    range: string | null;
    duration: string | null;
    components: string | null;
    concentration: boolean;
    ritual: boolean;
    classes: readonly string[];
  }>;
  sourceVersion: Readonly<{
    url: string;
    sha256: string;
    rawBlobPath: string;
    fetchedAt: string;
    index: Readonly<{
      url: string;
      sha256: string;
      rawBlobPath: string;
      fetchedAt: string;
      cardFingerprintSha256: string;
      metadataEvidenceText: string;
    }>;
  }>;
  citations: readonly Readonly<{ fieldPath: string; quote: string; sourceUrl: string }>[];
  extraction: Readonly<{ status: "ready" | "needs_review"; missingFields: readonly string[] }>;
}>;

/** Converts an immutable collector detail into typed review input, never canonical publication. */
export function spellCandidate(detail: SnapshotDetail): SnapshotSpellCandidate {
  if (detail.category !== "spells") throw new Error("Snapshot spell projection only accepts spell details.");
  const metadata = detail.indexMetadata;
  if (nextDndCardFingerprint(metadata) !== detail.indexSource.cardFingerprintSha256) {
    throw new Error("Snapshot spell metadata does not match the exact collected window.LIST card fingerprint.");
  }
  const text = detail.normalized.contentText;
  const level = integer(metadata.level, 0, 9);
  const school = spellSchool(metadata.school ?? metadata.item_icon_title);
  const castingTime = labelledValue(text, ["Casting Time", "Время накладывания", "Время сотворения"]);
  const range = labelledValue(text, ["Range", "Дистанция", "Дальность"]);
  const duration = labelledValue(text, ["Duration", "Длительность"]);
  const components = labelledValue(text, ["Components", "Компоненты"]);
  const tags = record(metadata.item_tags);
  const concentration = Boolean(tags.concentration) || /(?:concentration|концентрац)/iu.test(duration ?? "");
  const ritual = Boolean(tags.ritual) || /(?:ritual|ритуал)/iu.test(String(metadata.item_prefix_title ?? ""));
  const classes = stringIds(metadata.filter_class, "class");
  const aliases = typeof metadata.title_en === "string" && metadata.title_en.trim()
    ? [metadata.title_en.trim()] : [];
  const attributes = { level, school, castingTime, range, duration, components, concentration, ritual, classes };
  const metadataEvidenceText = spellMetadataEvidence(metadata);
  const missingFields = Object.entries(attributes)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  const citations = [
    { fieldPath: "$.title", quote: detail.normalized.title, sourceUrl: detail.sourceUrl },
    { fieldPath: "$.body", quote: text, sourceUrl: detail.sourceUrl },
    ...Object.entries(attributes).filter(([, value]) => value !== null).map(([name, value]) => ({
      fieldPath: `$.attributes.${name}`,
      quote: attributeEvidenceQuote(name, value, metadata, text),
      sourceUrl: detailEvidenceField(name, metadata, text) ? detail.sourceUrl : detail.indexSource.url,
    })),
  ];
  return {
    schemaVersion: 1, kind: "snapshotSpellCandidate", externalId: detail.externalId,
    sourceUrl: detail.sourceUrl, sha256: detail.sha256, parserVersion: detail.parserVersion,
    title: detail.normalized.title, aliases, body: text, attributes,
    sourceVersion: {
      url: detail.sourceUrl,
      sha256: detail.sha256,
      rawBlobPath: detail.blobPath,
      fetchedAt: detail.fetchedAt,
      index: {
        url: detail.indexSource.url,
        sha256: detail.indexSource.fingerprintSha256,
        rawBlobPath: detail.indexSource.rawBlobPath,
        fetchedAt: detail.indexSource.fetchedAt,
        cardFingerprintSha256: detail.indexSource.cardFingerprintSha256,
        metadataEvidenceText,
      },
    },
    citations, extraction: { status: missingFields.length === 0 ? "ready" : "needs_review", missingFields },
  };
}

function labelledValue(text: string, labels: readonly string[]): string | null {
  for (const label of labels) {
    const match = text.match(new RegExp(`(?:^|\\s)${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^.;]+[.;]?)`, "iu"));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function spellSchool(value: unknown): SpellSchool | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase("und");
  const aliases: Record<string, SpellSchool> = {
    ограждение: "abjuration", вызов: "conjuration", прорицание: "divination", очарование: "enchantment",
    воплощение: "evocation", иллюзия: "illusion", некромантия: "necromancy", преобразование: "transmutation",
  };
  if (normalized in aliases) return aliases[normalized];
  return SPELL_SCHOOLS.includes(normalized as SpellSchool) ? normalized as SpellSchool : null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;
}

function stringIds(value: unknown, prefix: string): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "number" || typeof item === "string").map((item) => `${prefix}:${String(item)}`))]
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function spellMetadataEvidence(metadata: Readonly<Record<string, unknown>>): string {
  const tags = record(metadata.item_tags);
  const values = {
    level: integer(metadata.level, 0, 9),
    school: typeof (metadata.school ?? metadata.item_icon_title) === "string"
      ? String(metadata.school ?? metadata.item_icon_title).normalize("NFC").trim() : null,
    ritual: Boolean(tags.ritual) || /(?:ritual|ритуал)/iu.test(String(metadata.item_prefix_title ?? "")),
    concentration: Boolean(tags.concentration),
    classes: stringIds(metadata.filter_class, "class"),
  };
  return ["window.LIST card metadata", ...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`)].join("\n");
}

export function spellDetailEvidence(text: string): Readonly<{
  castingTime: string | null;
  range: string | null;
  duration: string | null;
  components: string | null;
}> {
  return {
    castingTime: labelledValue(text, ["Casting Time", "Время накладывания", "Время сотворения"]),
    range: labelledValue(text, ["Range", "Дистанция", "Дальность"]),
    duration: labelledValue(text, ["Duration", "Длительность"]),
    components: labelledValue(text, ["Components", "Компоненты"]),
  };
}

function detailEvidenceField(name: string, metadata: Readonly<Record<string, unknown>>, text: string): boolean {
  if (["castingTime", "range", "duration", "components"].includes(name)) return true;
  if (name === "concentration") {
    const duration = labelledValue(text, ["Duration", "Длительность"]);
    return !Boolean(record(metadata.item_tags).concentration) && /(?:concentration|концентрац)/iu.test(duration ?? "");
  }
  return false;
}

function attributeEvidenceQuote(name: string, value: unknown, metadata: Readonly<Record<string, unknown>>, text: string): string {
  if (["castingTime", "range", "duration", "components"].includes(name)) return String(value);
  if (name === "concentration" && detailEvidenceField(name, metadata, text)) {
    const duration = labelledValue(text, ["Duration", "Длительность"]);
    if (!duration) throw new Error("Concentration detail evidence is absent.");
    return duration;
  }
  if (name === "school") {
    return JSON.stringify(String(metadata.school ?? metadata.item_icon_title).normalize("NFC").trim());
  }
  return JSON.stringify(value);
}
