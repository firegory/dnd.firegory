import Link from "next/link";

import { AppLayout } from "../../../components/ui/app-layout";
import { T } from "../../../components/ui/i18n";
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
    <AppLayout userRole="admin" wide>
      <div className="space-y-8">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/search" className="hover:text-accent"><T k="search" /></Link>
          <span>/</span>
          <span className="text-text-secondary"><T k="users" /></span>
        </nav>

        <section aria-labelledby="users-title">
          <h1 id="users-title" className="mb-4 text-2xl font-bold text-text-primary"><T k="users" /></h1>
          <div className="table-scroll rounded-xl border border-border" role="region" aria-labelledby="users-title" tabIndex={0}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase"><T k="user" /></th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase"><T k="currentRole" /></th>
                  <th className="print-action px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase"><T k="changeRole" /></th>
                  <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase"><T k="activity" /></th>
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
                    <td className="print-action px-4 py-3">
                      <form action={updateUserRoleAction} className="flex items-center gap-2">
                        <input type="hidden" name="userId" value={user.id} />
                        <select
                          name="role"
                          defaultValue={user.role}
                          aria-label={`Role for ${user.email}`}
                          className="rounded-lg border border-border bg-primary/60 px-3 py-2 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/20"
                        >
                          {USER_ROLES.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                        <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-primary hover:opacity-90">
                          <T k="saveRole" />
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
