"use client";

import Link from "next/link";

import { useUiLanguage } from "../../components/ui/i18n";
import type { FlatDetail as FlatDetailValue } from "../../server/compendium/flat-read-service";
import { compendiumEntryRoute, flatCollection } from "../../server/compendium/flat-schema";

const LABELS: Readonly<Record<string, readonly [string, string]>> = {
  category: ["Категория", "Category"], rarity: ["Редкость", "Rarity"], prerequisiteLevel: ["Уровень требования", "Prerequisite level"],
  prerequisiteText: ["Требование", "Prerequisite"], repeatable: ["Повторяемая", "Repeatable"], abilityScores: ["Характеристики", "Ability scores"],
  skillProficiencies: ["Владение навыками", "Skill proficiencies"], requiresAttunement: ["Требует настройки", "Requires attunement"],
  costCp: ["Стоимость (мм)", "Cost (cp)"], weightLb: ["Вес (фунты)", "Weight (lb)"], relatedTerms: ["Связанные термины", "Related terms"],
};

export function FlatDetail({ entry }: Readonly<{ entry: FlatDetailValue }>) {
  const { language, t } = useUiLanguage(); const collection = flatCollection(entry.entryType); const labelIndex = language === "ru" ? 0 : 1;
  return <article className="flat-detail">
    <Link className="print-action" href={`/${collection}?${new URLSearchParams({ edition: entry.edition, language: entry.language })}`}>{language === "ru" ? "← К списку" : "← Back to list"}</Link>
    <header><p>D&D {entry.edition}</p><h1>{entry.title}</h1></header>
    <dl className="flat-facts">{Object.entries(entry.projection).filter(([key]) => key !== "type").map(([key, value]) => <div key={key}><dt>{LABELS[key]?.[labelIndex] ?? key}</dt><dd>{display(value, language)}</dd></div>)}</dl>
    {entry.aliases.length ? <section><h2>{t("aliases")}</h2><p>{entry.aliases.join(", ")}</p></section> : null}
    <section className="flat-body"><p>{entry.body}</p></section>
    {entry.relations.length ? <section><h2>{language === "ru" ? "Связанные записи" : "Related entries"}</h2><ul>{entry.relations.map((relation) => <li key={`${entry.edition}-${entry.language}-${relation.direction}-${relation.type}-${relation.entryType}-${relation.entryId}`}><Link href={compendiumEntryRoute(relation.entryType, relation.entryId, entry)}>{relation.title}</Link> · {relation.type}</li>)}</ul></section> : null}
    <section><h2>{t("sourceVersions")}</h2><ul>{entry.sourceVersions.map((source) => <li key={`${source.sourceId}-${source.revisionId}`}>{source.code ?? source.title}{source.revision ? ` · ${source.revision}` : ""} · <code>{source.revisionId}</code></li>)}</ul></section>
    {entry.sourceVersion ? <section><h2>{t("collectorVersion")}</h2><a href={entry.sourceVersion.url} target="_blank" rel="noreferrer">{entry.sourceVersion.url}</a><p><code>{entry.sourceVersion.fingerprintSha256}</code></p></section> : null}
    <section className="flat-citations"><h2>{t("citations")}</h2>{entry.citations.map((citation) => <blockquote key={citation.id}><p>“{citation.quote}”</p><footer>{citation.section}{citation.page === null ? "" : ` · ${t("pageShort")} ${citation.page}`}{citation.previewUrl ? <> · <a className="print-action" href={citation.previewUrl} target="_blank" rel="noreferrer">{t("openPdfCitation")}</a></> : citation.sourceUrl ? <> · <a className="print-action" href={citation.sourceUrl} target="_blank" rel="noreferrer">{t("openExternalCitation")}</a></> : null} · <a className="print-action" href={citation.sourceDetailUrl}>{t("sourceDetails")}</a></footer></blockquote>)}</section>
  </article>;
}
function display(value: unknown, language: "ru" | "en"): string { if (Array.isArray(value)) return value.join(", "); if (typeof value === "boolean") return language === "ru" ? value ? "Да" : "Нет" : value ? "Yes" : "No"; return value === null ? "—" : String(value); }
