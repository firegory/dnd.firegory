import { AppLayout } from "../../../../components/ui/app-layout";
import { requireAdmin } from "../../../../server/auth/session";
import { EntryEditor } from "./editor-client";

export default async function EntryEditorPage() {
  await requireAdmin();
  return <AppLayout userRole="admin" wide><EntryEditor /></AppLayout>;
}
