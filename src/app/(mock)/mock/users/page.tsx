"use client";

import { useState } from "react";
import Link from "next/link";
import { MockSelect } from "../../../../components/mock/select";

const MOCK_USERS = [
  {
    id: "usr-1",
    name: "Егор",
    email: "egor@example.com",
    role: "admin",
    lastSeen: "сегодня, 17:58",
  },
  {
    id: "usr-2",
    name: "Марина",
    email: "marina@example.com",
    role: "premium",
    lastSeen: "вчера, 22:14",
  },
  {
    id: "usr-3",
    name: "Гость кампании",
    email: "guest@example.com",
    role: "user",
    lastSeen: "3 дня назад",
  },
];

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin", description: "Полный доступ" },
  { value: "premium", label: "Premium", description: "Платные источники" },
  { value: "user", label: "User", description: "Базовый доступ" },
];

const ROLE_STYLES: Record<string, string> = {
  admin: "bg-danger/15 text-danger",
  premium: "bg-accent/15 text-accent",
  user: "bg-surface-light text-text-muted",
};

export default function MockUsersPage() {
  const [users, setUsers] = useState(MOCK_USERS);

  return (
    <div className="space-y-8">
      <nav className="flex items-center gap-2 text-sm text-text-muted">
        <Link href="/mock/search" className="hover:text-accent">
          Поиск
        </Link>
        <span>/</span>
        <span className="text-text-secondary">Пользователи</span>
      </nav>

      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-2 text-sm font-semibold tracking-widest text-accent uppercase">
              User access
            </p>
            <h1 className="text-2xl font-bold text-text-primary">
              Права пользователей
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-muted">
              Отдельная mock-страница для управления ролями. Роли меняются
              локально без сохранения на сервере.
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
                    <p className="font-medium text-text-primary">{user.name}</p>
                    <p className="mt-1 text-xs text-text-muted">{user.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${ROLE_STYLES[user.role]}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <MockSelect
                      label="Роль"
                      value={user.role}
                      options={ROLE_OPTIONS}
                      onChange={(role) =>
                        setUsers((current) =>
                          current.map((item) =>
                            item.id === user.id ? { ...item, role } : item,
                          ),
                        )
                      }
                      className="min-w-44"
                    />
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap text-text-muted">
                    {user.lastSeen}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
