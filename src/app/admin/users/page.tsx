import Link from "next/link";

import { updateUserRoleAction } from "../../../server/auth/actions";
import { requireAdmin } from "../../../server/auth/session";
import { listUsers } from "../../../server/auth/users";
import { USER_ROLES } from "../../../server/auth/types";

export default async function AdminUsersPage() {
  await requireAdmin();
  const users = await listUsers();

  return (
    <main className="page-shell wide-page">
      <section className="hero-card" aria-labelledby="users-title">
        <p className="eyebrow">Admin</p>
        <h1 id="users-title">User roles</h1>
        <p className="lede">View registered users and assign user, premium, or admin roles.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Display name</th>
                <th>Role</th>
                <th>Last login</th>
                <th>Created</th>
                <th>Update</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.displayName ?? "—"}</td>
                  <td><code>{user.role}</code></td>
                  <td>{formatDate(user.lastLoginAt)}</td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td>
                    <form action={updateUserRoleAction} className="role-form">
                      <input type="hidden" name="userId" value={user.id} />
                      <select name="role" defaultValue={user.role} aria-label={`Role for ${user.email}`}>
                        {USER_ROLES.map((role) => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <button type="submit">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted"><Link href="/">Back to app</Link></p>
      </section>
    </main>
  );
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}
