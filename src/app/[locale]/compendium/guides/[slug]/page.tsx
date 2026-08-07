import Link from "next/link";
import { notFound } from "next/navigation";

import { GuideRenderer } from "../../../../../components/compendium/guide-renderer";
import { LocaleSync } from "../../../../../components/compendium/locale-sync";
import { AppLayout } from "../../../../../components/ui/app-layout";
import { requireUser } from "../../../../../server/auth/session";
import { getGuide, isGuideLocale, isGuideSlug } from "../../../../../server/compendium/guides";

export default async function GuidePage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  if (!isGuideLocale(locale) || !isGuideSlug(slug)) notFound();
  const user = await requireUser();
  const document = getGuide(slug, locale, user.role);
  if (!document) notFound();

  return (
    <AppLayout userRole={user.role}>
      <LocaleSync locale={locale} />
      <nav className="compendium-breadcrumbs" aria-label={locale === "ru" ? "Хлебные крошки" : "Breadcrumbs"}>
        <Link href={`/${locale}/compendium`}>{locale === "ru" ? "Справочник" : "Compendium"}</Link><span aria-hidden="true">/</span><span>{document.title}</span>
      </nav>
      <GuideRenderer document={document} />
    </AppLayout>
  );
}
