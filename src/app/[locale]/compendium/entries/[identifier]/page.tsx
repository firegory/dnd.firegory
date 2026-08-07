import Link from "next/link";
import { notFound } from "next/navigation";

import { LocaleSync } from "../../../../../components/compendium/locale-sync";
import { AppLayout } from "../../../../../components/ui/app-layout";
import { requireUser } from "../../../../../server/auth/session";
import { isGuideLocale } from "../../../../../server/compendium/guides";
import { categoryByEntryType } from "../../../../../server/compendium/landing";
import { CompendiumNotFoundError, CompendiumReadService } from "../../../../../server/compendium/read-service";

export default async function EntryPage({ params }: { params: Promise<{ locale: string; identifier: string }> }) {
  const { locale, identifier } = await params;
  if (!isGuideLocale(locale)) notFound();
  const user = await requireUser();
  let entry;
  try {
    entry = await new CompendiumReadService().getEntry(
      { role: user.role, userId: user.id }, identifier,
      { edition: "5.5e", language: locale },
    );
  } catch (error) {
    if (error instanceof CompendiumNotFoundError) notFound();
    throw error;
  }
  const category = categoryByEntryType(entry.entryType);

  return (
    <AppLayout userRole={user.role}>
      <LocaleSync locale={locale} />
      <nav className="compendium-breadcrumbs" aria-label={locale === "ru" ? "Хлебные крошки" : "Breadcrumbs"}>
        <Link href={`/${locale}/compendium`}>{locale === "ru" ? "Справочник" : "Compendium"}</Link><span aria-hidden="true">/</span>
        {category ? <Link href={`/${locale}/compendium/categories/${category.entryType}`}>{category.label[locale]}</Link> : null}<span aria-hidden="true">/</span><span>{entry.title}</span>
      </nav>
      <article className="entry-document">
        <header className="compendium-hero"><p className="compendium-kicker">{entry.edition} · {entry.entryType}</p><h1>{entry.title}</h1>{entry.summary ? <p>{entry.summary}</p> : null}</header>
        <div className="entry-body">{entry.body.split(/\n{2,}/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
        <footer className="entry-source">
          <h2>{locale === "ru" ? "Источник и цитаты" : "Source and citations"}</h2>
          <p><strong>{entry.source.publication.title}</strong>{entry.source.publication.attribution ? ` · ${entry.source.publication.attribution}` : ""}</p>
          <ul>{entry.citations.map((citation, index) => <li key={citationText(citation, "id") ?? index}>{citationText(citation, "quote") ?? (locale === "ru" ? "Цитата из источника" : "Source citation")}</li>)}</ul>
        </footer>
      </article>
    </AppLayout>
  );
}

function citationText(value: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof value[key] === "string" && value[key] ? value[key] : null;
}
