import { requireAdmin } from "../../../server/auth/session";
import { AppLayout } from "../../../components/ui/app-layout";
import { AdminEntitiesClient } from "./entities-client";

export default async function AdminEntitiesPage() {
  await requireAdmin();

  return (
    <AppLayout userRole="admin">
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-text-primary">
          <span>Entity Merge</span>
        </h1>
        <AdminEntitiesClient />
      </div>
    </AppLayout>
  );
}
