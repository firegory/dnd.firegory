import { requireUser } from "../../server/auth/session";
import { SearchForm } from "./search-form";
import { AppLayout } from "../../components/ui/app-layout";

export default async function SearchPage() {
  const user = await requireUser();

  return (
    <AppLayout userRole={user.role}>
      <div className="space-y-8">
        <SearchForm isAdmin={user.role === "admin"} />
      </div>
    </AppLayout>
  );
}
