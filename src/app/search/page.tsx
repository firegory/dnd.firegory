import { requireUser } from "../../server/auth/session";
import { SearchForm } from "./search-form";
import { AppLayout } from "../../components/ui/app-layout";

export default async function SearchPage() {
  const user = await requireUser();

  return (
    <AppLayout userRole={user.role}>
      <div className="space-y-8">
        <section className="rounded-2xl border border-border bg-surface p-6">
          <p className="mb-2 text-sm font-semibold tracking-widest text-accent uppercase">
            Citation-first search
          </p>
          <h1 className="text-2xl font-bold text-text-primary">Поиск правил</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-muted">
            Поиск и AI-ответы по доступным источникам. Вы вошли как {user.email}.
          </p>
        </section>
        <SearchForm />
      </div>
    </AppLayout>
  );
}
