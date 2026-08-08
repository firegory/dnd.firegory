import Link from "next/link";
import { notFound } from "next/navigation";

import { LocaleSync } from "../../../../../components/compendium/locale-sync";
import { AppLayout } from "../../../../../components/ui/app-layout";
import { requireUser } from "../../../../../server/auth/session";
import { isGuideLocale } from "../../../../../server/compendium/guides";
import { categoryByEntryType } from "../../../../../server/compendium/landing";
import { parseSelection } from "../../../../../server/compendium/http";
import { CompendiumNotFoundError, CompendiumReadService } from "../../../../../server/compendium/read-service";
import { citationPreviewHref } from "../../../../../server/citations/preview";

export default async function EntryPage({ params, searchParams }: { params: Promise<{ locale: string; identifier: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale, identifier } = await params;
  if (!isGuideLocale(locale)) notFound();
  const user = await requireUser();
  let entry;
  try {
    const url = new URL("/compendium/entries", "http://local");
    for (const [key, value] of Object.entries(await searchParams)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, item);
    const selection = parseSelection(url);
    entry = await new CompendiumReadService().getEntry(
      { role: user.role, userId: user.id }, identifier,
      { edition: selection.edition ?? "5.5e", language: selection.language ?? locale, category: selection.category },
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
          <p>
            <strong>{entry.source.publication.title}</strong>{entry.source.publication.attribution ? ` · ${entry.source.publication.attribution}` : ""}
            {safeExternalUrl(entry.source.publication.originUrl) ? <> · <a href={entry.source.publication.originUrl!} rel="noopener noreferrer">{locale === "ru" ? "Открыть источник" : "Open source"}</a></> : null}
          </p>
          <ul className="entry-citations">{entry.citations.map((citation, index) => {
            const quote = citationText(citation, "quote") ?? (locale === "ru" ? "Цитата из источника" : "Source citation");
            const page = citationNumber(citation, "page");
            const section = citationText(citation, "section");
            const chunkId = citationText(citation, "chunkId");
            const sourceId = citationText(citation, "sourceId");
            const fileId = citationText(citation, "fileId");
            const previewHref = citationPreviewHref({ chunkId, sourceId, fileId, page });
            return <li key={citationText(citation, "id") ?? index}>
              <blockquote>«{quote}»</blockquote>
              <span>{entry.source.publication.title}{page ? ` · ${locale === "ru" ? "стр." : "p."} ${page}` : ""}{section ? ` · ${section}` : ""}</span>
              {previewHref ? <a href={previewHref} target="_blank" rel="noopener noreferrer">{locale === "ru" ? "Превью цитаты" : "Citation preview"}</a> : null}
            </li>;
          })}</ul>
        </footer>
      </article>
    </AppLayout>
  );
}

function citationText(value: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof value[key] === "string" && value[key] ? value[key] : null;
}

function citationNumber(value: Readonly<Record<string, unknown>>, key: string): number | null {
  return typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] > 0 ? value[key] : null;
}

function safeExternalUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}
