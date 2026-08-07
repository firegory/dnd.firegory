import Link from "next/link";
import { notFound } from "next/navigation";

import { LocaleSync } from "../../../../../components/compendium/locale-sync";
import { AppLayout } from "../../../../../components/ui/app-layout";
import { requireUser } from "../../../../../server/auth/session";
import { isGuideLocale } from "../../../../../server/compendium/guides";
import { categoryByEntryType } from "../../../../../server/compendium/landing";
import { CompendiumReadService } from "../../../../../server/compendium/read-service";

export default async function CategoryPage({ params }: { params: Promise<{ locale: string; category: string }> }) {
  const { locale, category: value } = await params;
  if (!isGuideLocale(locale)) notFound();
  const category = categoryByEntryType(value);
  if (!category) notFound();
  const user = await requireUser();
  const result = await new CompendiumReadService().listEntries(
    { role: user.role, userId: user.id },
    { edition: "5.5e", language: locale, entryType: category.entryType, limit: 200 },
  );
  if (result.count === 0) notFound();

  return (
    <AppLayout userRole={user.role}>
      <LocaleSync locale={locale} />
      <nav className="compendium-breadcrumbs" aria-label={locale === "ru" ? "Хлебные крошки" : "Breadcrumbs"}>
        <Link href={`/${locale}/compendium`}>{locale === "ru" ? "Справочник" : "Compendium"}</Link><span aria-hidden="true">/</span><span>{category.label[locale]}</span>
      </nav>
      <header className="compendium-hero category-hero"><p className="compendium-kicker">{category.mark} · D&D 2024</p><h1>{category.label[locale]}</h1><p>{category.description[locale]}</p></header>
      <ol className="entry-list">
        {result.entries.map((entry) => (
          <li key={entry.versionId}>
            <Link href={`/${locale}/compendium/entries/${encodeURIComponent(entry.slug)}`}><strong>{entry.title}</strong>{entry.summary ? <span>{entry.summary}</span> : null}</Link>
            <small>{entry.source.publication.title}</small>
          </li>
        ))}
      </ol>
    </AppLayout>
  );
}
