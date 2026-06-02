import { requireUser } from "../../../server/auth/session";
import { AppLayout } from "../../../components/ui/app-layout";
import { AdminEntitiesClient } from "./entities-client";

export default async function AdminEntitiesPage() {
  const user = await requireUser();
  if (user.role !== "admin") {
    return (
      <AppLayout userRole={user.role}>
        <p className="p-8 text-text-muted">Access denied.</p>
      </AppLayout>
    );
  }

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
