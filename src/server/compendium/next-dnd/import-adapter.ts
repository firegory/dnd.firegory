import type { CompendiumImportRunService, ImportCandidateInput, ImportOccurrenceInput } from "../import-runs.ts";
import { NEXT_DND_CATEGORIES } from "./parser.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "./collector.ts";
import { SPELL_SCHOOLS, type SpellSchool } from "../spell-schema.ts";

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
    content: detail.category === "spells" ? spellCandidate(detail) : {
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
  sourceVersion: Readonly<{ url: string; sha256: string; rawBlobPath: string; fetchedAt: string }>;
  citations: readonly Readonly<{ fieldPath: string; quote: string; sourceUrl: string }>[];
  extraction: Readonly<{ status: "ready" | "needs_review"; missingFields: readonly string[] }>;
}>;

/** Converts an immutable collector detail into typed review input, never canonical publication. */
export function spellCandidate(detail: SnapshotDetail): SnapshotSpellCandidate {
  if (detail.category !== "spells") throw new Error("Snapshot spell projection only accepts spell details.");
  const metadata = detail.indexMetadata;
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
  const missingFields = Object.entries(attributes)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  const citations = [
    { fieldPath: "$.title", quote: detail.normalized.title, sourceUrl: detail.sourceUrl },
    { fieldPath: "$.body", quote: text, sourceUrl: detail.sourceUrl },
    ...Object.entries(attributes).filter(([, value]) => value !== null).map(([name, value]) => ({
      fieldPath: `$.attributes.${name}`,
      quote: evidenceQuote(value, text),
      sourceUrl: detail.sourceUrl,
    })),
  ];
  return {
    schemaVersion: 1, kind: "snapshotSpellCandidate", externalId: detail.externalId,
    sourceUrl: detail.sourceUrl, sha256: detail.sha256, parserVersion: detail.parserVersion,
    title: detail.normalized.title, aliases, body: text, attributes,
    sourceVersion: { url: detail.sourceUrl, sha256: detail.sha256, rawBlobPath: detail.blobPath, fetchedAt: detail.fetchedAt },
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

function evidenceQuote(value: unknown, text: string): string {
  const serialized = String(value);
  return text.includes(serialized) ? serialized : text;
}
