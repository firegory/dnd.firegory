import Link from "next/link";

import { AppLayout } from "../../../components/ui/app-layout";
import { updateUserRoleAction } from "../../../server/auth/actions";
import { requireAdmin } from "../../../server/auth/session";
import { listUsers } from "../../../server/auth/users";
import { USER_ROLES } from "../../../server/auth/types";

const ROLE_STYLES: Record<string, string> = {
  admin: "bg-danger/15 text-danger",
  premium: "bg-accent/15 text-accent",
  user: "bg-surface-light text-text-muted",
};

export default async function AdminUsersPage() {
  await requireAdmin();
  const users = await listUsers();

  return (
    <AppLayout>
      <div className="space-y-8">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/search" className="hover:text-accent">Поиск</Link>
          <span>/</span>
          <span className="text-text-secondary">Пользователи</span>
        </nav>

        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="mb-2 text-sm font-semibold tracking-widest text-accent uppercase">
                User access
              </p>
              <h1 className="text-2xl font-bold text-text-primary">Права пользователей</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-muted">
                Управление ролями пользователей: admin, premium и user.
              </p>
            </div>
            <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
              {users.length} пользователя
            </span>
          </div>
        </section>

        <section>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Пользователь</th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Текущая роль</th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Изменить роль</th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Активность</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-border-light transition-colors hover:bg-surface-light/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{user.displayName ?? "—"}</p>
                      <p className="mt-1 text-xs text-text-muted">{user.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${ROLE_STYLES[user.role]}`}>
                        {user.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <form action={updateUserRoleAction} className="flex items-center gap-2">
                        <input type="hidden" name="userId" value={user.id} />
                        <select
                          name="role"
                          defaultValue={user.role}
                          aria-label={`Role for ${user.email}`}
                          className="rounded-lg border border-border bg-primary/60 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        >
                          {USER_ROLES.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                        <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-primary hover:opacity-90">
                          Save
                        </button>
                      </form>
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-text-muted">
                      {formatDate(user.lastLoginAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppLayout>
  );
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}
