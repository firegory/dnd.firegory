import { AppLayout } from "../../../../components/ui/app-layout";
import { requireAdmin } from "../../../../server/auth/session";
import { ImportRunsDashboard } from "./runs-dashboard";

export default async function ImportRunsPage() {
  await requireAdmin();
  return <AppLayout userRole="admin" wide><ImportRunsDashboard /></AppLayout>;
}
