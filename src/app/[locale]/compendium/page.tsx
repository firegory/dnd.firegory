import Link from "next/link";
import { notFound } from "next/navigation";

import { LocaleSync } from "../../../components/compendium/locale-sync";
import { AppLayout } from "../../../components/ui/app-layout";
import { requireUser } from "../../../server/auth/session";
import { isGuideLocale, listGuides } from "../../../server/compendium/guides";
import { COMPENDIUM_CATEGORIES } from "../../../server/compendium/landing";
import { CompendiumReadService } from "../../../server/compendium/read-service";

export default async function CompendiumLanding({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: value } = await params;
  if (!isGuideLocale(value)) notFound();
  const user = await requireUser();
  const counts = await new CompendiumReadService().listEntryTypeCounts(
    { role: user.role, userId: user.id },
    { edition: "5.5e", language: value },
  );
  const countByType = new Map(counts.map(({ entryType, count }) => [entryType, count]));
  const categories = COMPENDIUM_CATEGORIES.filter(({ entryType }) => (countByType.get(entryType) ?? 0) > 0);
  const guides = listGuides(value, user.role);
  const text = value === "ru" ? ru : en;

  return (
    <AppLayout userRole={user.role}>
      <LocaleSync locale={value} />
      <header className="compendium-hero">
        <p className="compendium-kicker">D&D 2024</p>
        <h1>{text.title}</h1>
        <p>{text.summary}</p>
      </header>

      <section className="compendium-section" aria-labelledby="guides-heading">
        <div className="section-heading"><p>{text.beginHere}</p><h2 id="guides-heading">{text.guides}</h2></div>
        <div className="guide-tile-grid">
          {guides.map((guide, index) => (
            <Link className="guide-tile" href={`/${value}/compendium/guides/${guide.slug}`} key={guide.slug}>
              <span aria-hidden="true">0{index + 1}</span><h3>{guide.title}</h3><p>{guide.summary}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="compendium-section" aria-labelledby="categories-heading">
        <div className="section-heading"><p>{text.library}</p><h2 id="categories-heading">{text.categories}</h2></div>
        {categories.length > 0 ? (
          <div className="category-tile-grid">
            {categories.map((category) => (
              <Link className="category-tile" href={`/${value}/compendium/categories/${category.entryType}`} key={category.entryType}>
                <span className="category-mark" aria-hidden="true">{category.mark}</span>
                <span><strong>{category.label[value]}</strong><small>{category.description[value]}</small></span>
                <b aria-label={`${countByType.get(category.entryType)} ${text.entries}`}>{countByType.get(category.entryType)}</b>
              </Link>
            ))}
          </div>
        ) : <p className="compendium-empty">{text.empty}</p>}
      </section>
    </AppLayout>
  );
}

const ru = { title: "Справочник приключенца", summary: "Проверенные материалы 2024 года с доступом по роли и цитатами из источников.", beginHere: "Начните здесь", guides: "Первые шаги", library: "Библиотека", categories: "Категории", entries: "записей", empty: "В вашей роли пока нет доступных материалов этой редакции." };
const en = { title: "Adventurer's compendium", summary: "Reviewed 2024 material with role-aware access and source citations.", beginHere: "Begin here", guides: "First steps", library: "Library", categories: "Categories", entries: "entries", empty: "No material from this edition is available to your role yet." };
