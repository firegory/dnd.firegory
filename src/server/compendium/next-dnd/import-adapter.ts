import type { CompendiumImportRunService, ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";
import { NEXT_DND_CATEGORIES, nextDndCardFingerprint } from "./parser.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "./collector.ts";
import { SPELL_SCHOOLS, type SpellSchool } from "../spell-schema.ts";
import { creatureEvidencePaths, normalizeChallengeRating, validateCreatureProjection, type CreatureBlock, type CreatureProjection } from "../creature-schema.ts";

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
        : detail.category === "bestiary" ? creatureMetadataEvidence(detail.indexMetadata) : null,
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
    content: detail.category === "spells" ? spellCandidate(detail) : detail.category === "bestiary" ? creatureCandidate(detail) : {
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

export type SnapshotCreatureCandidate = Readonly<{
  schemaVersion: 1; kind: "snapshotCreatureCandidate"; externalId: string; sourceUrl: string; sha256: string;
  parserVersion: string; title: string; aliases: readonly string[]; body: string; attributes: CreatureProjection;
  sourceVersion: SnapshotSpellCandidate["sourceVersion"];
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

/** Deterministic plain-text stat-block transform. It never retains collector HTML. */
export function creatureCandidate(detail: SnapshotDetail): SnapshotCreatureCandidate {
  if (detail.category !== "bestiary") throw new Error("Snapshot creature projection only accepts bestiary details.");
  if (nextDndCardFingerprint(detail.indexMetadata) !== detail.indexSource.cardFingerprintSha256) throw new Error("Snapshot creature metadata does not match its immutable index card fingerprint.");
  const body = detail.normalized.contentText.normalize("NFC").trim();
  const metadata = detail.indexMetadata;
  const aliases = typeof metadata.title_en === "string" && metadata.title_en.trim() ? [metadata.title_en.trim()] : [];
  const headerLine = body.split("\n").find((line) => /\b(Tiny|Small|Medium|Large|Huge|Gargantuan)\b/i.test(line)) ?? "";
  const header = headerLine.match(/\b(Tiny|Small|Medium|Large|Huge|Gargantuan)\s+([^,.;]+)(?:,\s*([^.;]+))?/i);
  const size = header?.[1]?.toLowerCase();
  const creatureType = header?.[2]?.trim();
  const alignment = header?.[3]?.trim() ?? null;
  const acText = labelledCreatureValue(body, ["Armor Class", "Класс Доспеха", "КД"]);
  const hpText = labelledCreatureValue(body, ["Hit Points", "Хиты"]);
  const speedText = labelledCreatureValue(body, ["Speed", "Скорость"]);
  const crText = labelledCreatureValue(body, ["Challenge", "Challenge Rating", "Опасность", "Показатель опасности"])
    ?? scalarMetadata(metadata, ["challenge_rating", "challenge", "cr"]);
  const armor = acText?.match(/(\d+)(?:\s*\(([^)]+)\))?/);
  const hp = hpText?.match(/(\d+)(?:\s*\(([^)]+)\))?/);
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map((key) => {
    const labels: Record<string, string> = { str: "(?:STR|СИЛ)", dex: "(?:DEX|ЛОВ)", con: "(?:CON|ТЕЛ)", int: "(?:INT|ИНТ)", wis: "(?:WIS|МДР)", cha: "(?:CHA|ХАР)" };
    return [key, Number(body.match(new RegExp(`${labels[key]}\\s*(\\d+)`, "iu"))?.[1] ?? Number.NaN)];
  }));
  const raw: Record<string, unknown> = {
    size, creatureType, alignment, challengeRating: crText ? normalizeChallengeRating(crText.match(/\d+(?:\s*\/\s*\d+)?/)?.[0] ?? crText) : null,
    armorClass: armor ? [{ value: Number(armor[1]), ...(armor[2] ? { note: armor[2].trim() } : {}) }] : null,
    hitPoints: hp ? { average: Number(hp[1]), ...(hp[2] ? { formula: hp[2].replace(/\s+/g, " ").trim() } : {}) } : null,
    speeds: speedText ? parseSpeeds(speedText) : null, abilities,
    saves: parseModifiers(labelledCreatureValue(body, ["Saving Throws", "Спасброски"]) ?? ""),
    skills: parseModifiers(labelledCreatureValue(body, ["Skills", "Навыки"]) ?? ""),
    damageResistances: splitList(labelledCreatureValue(body, ["Damage Resistances", "Сопротивление урону"]) ?? ""),
    damageImmunities: splitList(labelledCreatureValue(body, ["Damage Immunities", "Иммунитет к урону"]) ?? ""),
    conditionImmunities: splitList(labelledCreatureValue(body, ["Condition Immunities", "Иммунитет к состояниям"]) ?? ""),
    senses: splitList(labelledCreatureValue(body, ["Senses", "Чувства"])?.replace(/passive Perception\s*\d+/i, "") ?? ""),
    passivePerception: Number(body.match(/(?:passive Perception|пассивное Восприятие)\s*(\d+)/iu)?.[1] ?? Number.NaN),
    languages: splitList(labelledCreatureValue(body, ["Languages", "Языки"]) ?? ""),
    traits: parseSectionBlocks(body, ["Traits", "Особенности"], ["Actions", "Действия"]),
    actions: parseSectionBlocks(body, ["Actions", "Действия"], ["Bonus Actions", "Бонусные действия", "Reactions", "Реакции", "Legendary Actions", "Легендарные действия"]),
    bonusActions: parseSectionBlocks(body, ["Bonus Actions", "Бонусные действия"], ["Reactions", "Реакции", "Legendary Actions", "Легендарные действия"]),
    reactions: parseSectionBlocks(body, ["Reactions", "Реакции"], ["Legendary Actions", "Легендарные действия"]),
    legendaryActions: parseSectionBlocks(body, ["Legendary Actions", "Легендарные действия"], []),
  };
  const missingFields = Object.entries(raw).filter(([key, value]) => value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))
    || (Array.isArray(value) && value.length === 0 && ["armorClass", "speeds"].includes(key))).map(([key]) => key);
  let attributes: CreatureProjection;
  try { attributes = validateCreatureProjection(raw); }
  catch { attributes = raw as CreatureProjection; if (!missingFields.includes("statBlock")) missingFields.push("statBlock"); }
  const metadataEvidenceText = creatureMetadataEvidence(metadata);
  const citations = missingFields.length === 0 ? [
    { fieldPath: "$.title", quote: detail.normalized.title, sourceUrl: detail.sourceUrl },
    { fieldPath: "$.body", quote: body, sourceUrl: detail.sourceUrl },
    ...creatureEvidenceCitations(attributes, body, metadataEvidenceText, detail.sourceUrl, detail.indexSource.url),
  ] : [];
  return { schemaVersion: 1, kind: "snapshotCreatureCandidate", externalId: detail.externalId, sourceUrl: detail.sourceUrl,
    sha256: detail.sha256, parserVersion: detail.parserVersion, title: detail.normalized.title, aliases, body, attributes,
    sourceVersion: { url: detail.sourceUrl, sha256: detail.sha256, rawBlobPath: detail.blobPath, fetchedAt: detail.fetchedAt,
      index: { url: detail.indexSource.url, sha256: detail.indexSource.fingerprintSha256, rawBlobPath: detail.indexSource.rawBlobPath,
        fetchedAt: detail.indexSource.fetchedAt, cardFingerprintSha256: detail.indexSource.cardFingerprintSha256, metadataEvidenceText } },
    citations, extraction: { status: missingFields.length ? "needs_review" : "ready", missingFields } };
}

export function creatureMetadataEvidence(metadata: Readonly<Record<string, unknown>>): string {
  return ["window.LIST bestiary card metadata", ...["title_en", "size", "type", "challenge_rating", "challenge", "cr"]
    .filter((key) => key in metadata).map((key) => `${key}=${JSON.stringify(metadata[key])}`)].join("\n");
}

function labelledCreatureValue(text: string, labels: readonly string[]): string | null {
  for (const line of text.split("\n")) {
    for (const label of [...labels].sort((left, right) => right.length - left.length)) {
      const match = line.match(new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "iu"));
      if (match?.[1]?.trim()) return match[1].trim();
    }
  }
  return null;
}
function parseSpeeds(value: string): CreatureProjection["speeds"] { return value.split(/[,;]/).flatMap((part, index) => { const match = part.trim().match(/(?:(walk|burrow|climb|fly|swim|ходьба|копая|лазая|л[её]тая|плавая)\s*)?(\d+)\s*(ft|feet|фут(?:ов|а)?|m|м)\.?\s*(?:\(([^)]+)\))?/iu); if (!match) return []; const aliases: Record<string, CreatureProjection["speeds"][number]["mode"]> = { walk: "walk", burrow: "burrow", climb: "climb", fly: "fly", swim: "swim", ходьба: "walk", копая: "burrow", лазая: "climb", летая: "fly", лётая: "fly", плавая: "swim" }; return [{ mode: aliases[match[1]?.toLocaleLowerCase("und") ?? "walk"] ?? (index === 0 ? "walk" : "walk"), distance: Number(match[2]), unit: /^m|м$/iu.test(match[3]) ? "m" : "ft", ...(match[4] ? { note: match[4].trim() } : {}) }]; }); }
function parseModifiers(value: string): Record<string, number> { return Object.fromEntries([...value.matchAll(/([\p{L}][\p{L} ]*?)\s*([+-]\d+)/gu)].map((match) => [match[1].trim(), Number(match[2])])); }
function splitList(value: string): string[] { return value.split(/[,;]/).map((item) => item.trim()).filter((item) => item && !/^(?:-|—|none|нет)$/iu.test(item)); }
function parseSectionBlocks(text: string, headings: readonly string[], endHeadings: readonly string[]): CreatureBlock[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = new RegExp(`^(?:${headings.map(escapeRegExp).join("|")})\\s*:?$`, "iu");
  const ending = endHeadings.length ? new RegExp(`^(?:${endHeadings.map(escapeRegExp).join("|")})\\s*:?$`, "iu") : null;
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const remaining = lines.slice(start + 1);
  const end = ending ? remaining.findIndex((line) => ending.test(line)) : -1;
  const section = end < 0 ? remaining : remaining.slice(0, end);
  const blocks: CreatureBlock[] = [];
  for (let index = 0; index < section.length; index++) {
    const match = section[index].match(/^(.{1,300}?[.!?])\s+(.+)$/u);
    if (match) blocks.push({ name: match[1].replace(/[.!?]$/, "").trim(), text: match[2].trim() });
    else if (section[index].length <= 300 && section[index + 1]) blocks.push({ name: section[index].replace(/[.!?]$/, ""), text: section[++index] });
  }
  return blocks;
}
function scalarMetadata(metadata: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null { for (const key of keys) if (typeof metadata[key] === "string" || typeof metadata[key] === "number") return String(metadata[key]); return null; }
export function creatureEvidenceCitations(projection: CreatureProjection, body: string, metadata: string, sourceUrl: string, indexUrl: string): readonly Readonly<{ fieldPath: string; quote: string; sourceUrl: string }>[] {
  return creatureEvidencePaths(projection).map((fieldPath) => {
    const value = creatureValueAtPath(projection, fieldPath);
    const quote = creatureEvidenceQuote(fieldPath, body, metadata, value);
    assertCreatureEvidence(fieldPath, value, quote);
    return { fieldPath, quote, sourceUrl: body.split("\n").includes(quote) ? sourceUrl : indexUrl };
  });
}

function creatureEvidenceQuote(path: string, body: string, metadata: string, value: unknown): string {
  const key = path.match(/^\$\.attributes\.([A-Za-z]+)/)?.[1] ?? "";
  const labels: Record<string, string[]> = { armorClass: ["Armor Class", "Класс Доспеха", "КД"], hitPoints: ["Hit Points", "Хиты"], speeds: ["Speed", "Скорость"], challengeRating: ["Challenge Rating", "Challenge", "Опасность", "Показатель опасности"], saves: ["Saving Throws", "Спасброски"], skills: ["Skills", "Навыки"], damageResistances: ["Damage Resistances", "Сопротивление урону"], damageImmunities: ["Damage Immunities", "Иммунитет к урону"], conditionImmunities: ["Condition Immunities", "Иммунитет к состояниям"], senses: ["Senses", "Чувства"], passivePerception: ["Senses", "Чувства"], languages: ["Languages", "Языки"] };
  if (["size", "creatureType", "alignment"].includes(key)) return body.split("\n").find((line) => /\b(Tiny|Small|Medium|Large|Huge|Gargantuan)\b/i.test(line)) ?? "";
  if (key === "abilities") { const ability = path.split(".").at(-1)?.toUpperCase() ?? ""; return body.split("\n").find((line) => new RegExp(`(?:^|\\s)${ability}\\s+\\d+`, "i").test(line)) ?? ""; }
  if (["traits", "actions", "bonusActions", "reactions", "legendaryActions"].includes(key) && isRecord(value)) return body.split("\n").find((line) => line.includes(String(value.name)) && line.includes(String(value.text))) ?? "";
  const line = body.split("\n").find((candidate) => (labels[key] ?? []).some((label) => new RegExp(`^${escapeRegExp(label)}(?:\\s|:)`, "iu").test(candidate)));
  if (line) return line;
  if (key === "challengeRating") return metadata.split("\n").find((candidate) => /^(?:challenge_rating|challenge|cr)=/.test(candidate)) ?? "";
  return hasScalarValues(value) ? "" : body;
}

function creatureValueAtPath(projection: CreatureProjection, path: string): unknown {
  const parts = path.replace(/^\$\.attributes\./, "").replace(/\[([0-9]+)\]/g, ".$1").split(".");
  return parts.reduce<unknown>((value, part) => Array.isArray(value) ? value[Number(part)] : isRecord(value) ? value[part] : undefined, projection);
}

function assertCreatureEvidence(path: string, value: unknown, quote: string): void {
  if (!quote) throw new Error(`Creature field ${path} has no exact immutable evidence line.`);
  if (path.endsWith("challengeRating")) {
    const challenge = value as CreatureProjection["challengeRating"];
    if (!numericValues(quote).some((number) => Math.abs(number - challenge.numerator / challenge.denominator) < 0.000001)) throw new Error(`Creature field ${path} is unsupported by its evidence line.`);
    return;
  }
  const normalized = normalizeCreatureEvidence(quote);
  if (path.endsWith(".saves") || path.endsWith(".skills")) {
    for (const key of Object.keys(value as Record<string, unknown>)) if (!normalized.includes(normalizeCreatureEvidence(key))) throw new Error(`Creature field ${path} is unsupported by its evidence line.`);
  }
  for (const scalar of scalarCreatureValues(value)) {
    if (typeof scalar === "number" && !numericValues(quote).includes(scalar)) throw new Error(`Creature field ${path} is unsupported by its evidence line.`);
    if (typeof scalar === "string" && scalar !== "walk" && !normalized.includes(normalizeCreatureEvidence(scalar))) throw new Error(`Creature field ${path} is unsupported by its evidence line.`);
  }
}

function scalarCreatureValues(value: unknown): (string | number)[] { if (Array.isArray(value)) return value.flatMap(scalarCreatureValues); if (isRecord(value)) return Object.values(value).flatMap(scalarCreatureValues); return typeof value === "string" || typeof value === "number" ? [value] : []; }
function hasScalarValues(value: unknown): boolean { return scalarCreatureValues(value).length > 0; }
function numericValues(value: string): number[] { return [...value.matchAll(/(?<![\d/])-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?(?![\d/])/g)].map((match) => { const [left, right] = match[0].split("/").map(Number); return right ? left / right : left; }); }
function normalizeCreatureEvidence(value: string): string { return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

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
