import { notFound } from "next/navigation";
import Link from "next/link";

import { requireUser } from "../../../../server/auth/session";
import { getAccessibleSourceIds } from "../../../../server/access/retrieval-filter";
import { getEntityById, listChildrenOf } from "../../../../server/entities/storage";
import { ENTITY_CONFIG, type EntityType } from "../../../../server/entities/types";
import { AppLayout } from "../../../../components/ui/app-layout";
import { EntityAttributes } from "./entity-attributes";
import { ClassDetailClient } from "./class-detail-client";
import { MarkdownText } from "../../../../components/ui/markdown-text";

type PageProps = {
  params: Promise<{ type: string; id: string }>;
};

export default async function EntityDetailPage({ params }: PageProps) {
  const user = await requireUser();
  const { type: typeSlug, id } = await params;

  const entity = await getEntityById(id);
  if (!entity) notFound();

  const accessibleSourceIds = await getAccessibleSourceIds({
    role: user.role,
    userId: user.id,
  });
  if (!accessibleSourceIds.includes(entity.sourceId)) notFound();

  const config = ENTITY_CONFIG[entity.entityType];
  const typeSlugFromConfig = config.slug;
  if (typeSlug !== typeSlugFromConfig) notFound();

  if (entity.entityType === "class" || entity.entityType === "species") {
    const [features, subclasses] = await Promise.all([
      listChildrenOf(id, "class_feature"),
      listChildrenOf(id, "subclass"),
    ]);

    return (
      <AppLayout userRole={user.role}>
        <div className="space-y-6">
          <nav className="flex items-center gap-2 text-sm text-text-muted">
            <Link href="/browse" className="hover:text-accent">Browse</Link>
            <span>/</span>
            <Link href={`/browse/${typeSlugFromConfig}`} className="hover:text-accent">
              {entity.entityType.replace(/_/g, " ")}
            </Link>
            <span>/</span>
            <span className="text-text-secondary">{entity.name}</span>
          </nav>

          <section className="rounded-2xl border border-border bg-surface p-6">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <h1 className="text-2xl font-bold text-text-primary">{entity.name}</h1>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                    {entity.entityType.replace(/_/g, " ")}
                  </span>
                  {entity.pageNumbers.length > 0 && (
                    <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                      p. {entity.pageNumbers.join(", ")}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {entity.description && (
              <div className="mt-4 border-t border-border pt-4">
                <MarkdownText content={entity.description} />
              </div>
            )}
          </section>

          <EntityAttributes entityType={entity.entityType} attributes={entity.attributes} />

          <ClassDetailClient features={features} subclasses={subclasses} entityType={entity.entityType} />

          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-3 text-lg font-bold text-text-primary">Source</h2>
            <p className="text-sm text-text-secondary">
              {entity.sourceTitle}
              {entity.pageNumbers.length > 0 && (
                <> &middot; p. {entity.pageNumbers.join(", ")}</>
              )}
            </p>
          </section>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout userRole={user.role}>
      <div className="space-y-6">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/browse" className="hover:text-accent">Browse</Link>
          <span>/</span>
          <Link href={`/browse/${typeSlugFromConfig}`} className="hover:text-accent">
            {entity.entityType.replace(/_/g, " ")}
          </Link>
          <span>/</span>
          <span className="text-text-secondary">{entity.name}</span>
        </nav>

        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="flex items-start gap-4">
          <div className="flex-1">
              <h1 className="text-2xl font-bold text-text-primary">{entity.name}</h1>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                  {entity.entityType.replace(/_/g, " ")}
                </span>
                {entity.pageNumbers.length > 0 && (
                  <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                    p. {entity.pageNumbers.join(", ")}
                  </span>
                )}
              </div>
            </div>
          </div>

          {entity.description && (
            <div className="mt-4 border-t border-border pt-4">
              <MarkdownText content={entity.description} />
            </div>
          )}
        </section>

        <EntityAttributes entityType={entity.entityType} attributes={entity.attributes} />

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-3 text-lg font-bold text-text-primary">Source</h2>
          <p className="text-sm text-text-secondary">
            {entity.sourceTitle}
            {entity.pageNumbers.length > 0 && (
              <> &middot; p. {entity.pageNumbers.join(", ")}</>
            )}
          </p>
        </section>
      </div>
    </AppLayout>
  );
}
