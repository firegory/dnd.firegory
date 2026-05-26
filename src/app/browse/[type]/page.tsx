import { notFound } from "next/navigation";

import { requireUser } from "../../../server/auth/session";
import { getAccessibleSourceIds } from "../../../server/access/retrieval-filter";
import { listEntitiesByType } from "../../../server/entities/storage";
import { getEntityTypeBySlug, ENTITY_CONFIG } from "../../../server/entities/types";
import { AppLayout } from "../../../components/ui/app-layout";
import { EntityList } from "./entity-list";
import { EntityFilters } from "./entity-filters";

type PageProps = { params: Promise<{ type: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function EntityTypePage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { type: typeSlug } = await params;
  const entityType = getEntityTypeBySlug(typeSlug);

  if (!entityType) notFound();

  const resolvedSearchParams = await searchParams;
  const config = ENTITY_CONFIG[entityType];

  const page = Math.max(1, parseInt(String(resolvedSearchParams.page ?? "1"), 10));
  const filters: Record<string, string> = {};
  for (const filterDef of config.filters) {
    const value = resolvedSearchParams[filterDef.key];
    if (typeof value === "string" && value) filters[filterDef.key] = value;
  }

  const sourceIds = await getAccessibleSourceIds({
    role: user.role,
    userId: user.id,
  });

  const result = await listEntitiesByType(entityType, {
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    page,
    pageSize: 20,
    sourceIds,
  });

  const filterQueryString = Object.entries(filters)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  return (
    <AppLayout userRole={user.role}>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-text-primary">
            {entityType.replace(/_/g, " ")}
          </h1>
          <span className="rounded-full bg-accent/15 px-3 py-1 text-sm font-bold text-accent">
            {result.total}
          </span>
        </div>

        {config.filters.length > 0 && (
          <EntityFilters typeSlug={typeSlug} config={config} currentFilters={filters} />
        )}

        <EntityList
          entities={result.items}
          typeSlug={typeSlug}
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          filterParams={filterQueryString || undefined}
        />
      </div>
    </AppLayout>
  );
}
