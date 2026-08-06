import { AppLayout } from "../../../../../components/ui/app-layout";
import { requireAdmin } from "../../../../../server/auth/session";
import { ImportRunReview } from "./review-client";

export default async function ImportRunPage({ params }: { params: Promise<{ runId: string }> }) {
  await requireAdmin();
  const { runId } = await params;
  return <AppLayout userRole="admin" wide><ImportRunReview runId={runId} /></AppLayout>;
}
