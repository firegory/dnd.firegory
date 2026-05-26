import Link from "next/link";

import { requireUser } from "../../server/auth/session";
import { AppLayout } from "../../components/ui/app-layout";
import { ENTITY_TYPES, ENTITY_CONFIG, type EntityType } from "../../server/entities/types";
import { countEntitiesByType } from "../../server/entities/storage";
import { BrowseTypeCard } from "./browse-type-card";

export default async function BrowsePage() {
  const user = await requireUser();

  const counts = await countEntitiesByType();

  return (
    <AppLayout userRole={user.role}>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            Entity Catalog
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Browse extracted D&D entities by type
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENTITY_TYPES.map((type) => (
            <BrowseTypeCard
              key={type}
              type={type}
              config={ENTITY_CONFIG[type]}
              count={counts[type] ?? 0}
            />
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
