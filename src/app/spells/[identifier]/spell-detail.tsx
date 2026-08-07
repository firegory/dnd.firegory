"use client";

import Link from "next/link";

import { useUiLanguage } from "../../../components/ui/i18n";
import type { SpellDetail as SpellDetailValue } from "../../../server/compendium/spell-read-service";

export function SpellDetail({ spell }: Readonly<{ spell: SpellDetailValue }>) {
  const { t } = useUiLanguage();
  const facts = [
    [t("spellLevel"), String(spell.level)], [t("spellSchool"), spell.school],
    [t("castingTime"), spell.castingTime], [t("range"), spell.range],
    [t("duration"), spell.duration], [t("components"), spell.components],
    [t("spellRitual"), spell.ritual ? t("yes") : t("no")],
    [t("spellConcentration"), spell.concentration ? t("yes") : t("no")],
  ];
  return (
    <article className="spell-detail">
      <Link className="spell-back print-action" href="/spells">← {t("backToSpells")}</Link>
      <header><span className="spell-level-badge">{spell.level}</span><div><p>D&D {spell.edition}</p><h1>{spell.title}</h1></div></header>
      <dl className="spell-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {spell.classes.length ? <section><h2>{t("classes")}</h2><p>{spell.classes.join(", ")}</p></section> : null}
      {spell.aliases.length ? <section><h2>{t("aliases")}</h2><p>{spell.aliases.join(", ")}</p></section> : null}
      <section className="spell-body"><p>{spell.body}</p></section>
      <section><h2>{t("sourceVersions")}</h2><ul>{spell.sourceVersions.map((source) => (
        <li key={`${source.sourceId}-${source.revisionId}`}>{source.code ?? source.title}{source.revision ? ` · ${source.revision}` : ""} · <code>{source.revisionId}</code></li>
      ))}</ul></section>
      <section className="spell-citations"><h2>{t("citations")}</h2>{spell.citations.map((citation) => (
        <blockquote key={citation.id}><p>“{citation.quote}”</p><footer>{citation.section} · p. {citation.page}{citation.previewUrl ? <> · <a className="print-action" href={citation.previewUrl} target="_blank" rel="noreferrer">{t("openPdfCitation")}</a></> : null}</footer></blockquote>
      ))}</section>
    </article>
  );
}
