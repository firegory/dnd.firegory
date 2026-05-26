"use client";

import Link from "next/link";

import type { EntityRecord } from "../../../server/entities/types";
import { useUiLanguage } from "../../../components/ui/i18n";

export function EntityList({
  entities,
  typeSlug,
  total,
  page,
  pageSize,
  filterParams,
}: {
  entities: readonly EntityRecord[];
  typeSlug: string;
  total: number;
  page: number;
  pageSize: number;
  filterParams?: string;
}) {
  const { t } = useUiLanguage();

  if (entities.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
        {t("noEntities")}
      </div>
    );
  }

  const totalPages = Math.ceil(total / pageSize);
  const baseQuery = filterParams ? `${filterParams}&` : "";

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {entities.map((entity) => (
          <Link
            key={entity.id}
            href={`/browse/${typeSlug}/${entity.id}`}
            className="block rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/20"
          >
            <h3 className="text-lg font-bold text-text-primary">{entity.name}</h3>
            {entity.description && (
              <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                {entity.description}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
              {entity.pageNumbers.length > 0 && (
                <span className="rounded-full bg-surface-light px-2 py-0.5">
                  p. {entity.pageNumbers.join(", ")}
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          {page > 1 && (
            <PageLink href={`/browse/${typeSlug}?${baseQuery}page=${page - 1}`} label="← Prev" />
          )}
          <span className="text-sm text-text-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <PageLink href={`/browse/${typeSlug}?${baseQuery}page=${page + 1}`} label="Next →" />
          )}
        </div>
      )}
    </div>
  );
}

function PageLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
    >
      {label}
    </Link>
  );
}
