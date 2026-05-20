"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { MockSelect } from "../../../../components/mock/select";

const MOCK_JOBS = [
  {
    id: "job-1",
    title: "Player's Handbook 2024 (ru)",
    status: "completed" as const,
    language: "ru",
    accessTier: "open",
    processedChunks: 2572,
    createdAt: "2026-05-20 14:32",
  },
  {
    id: "job-2",
    title: "Monster Manual 2024 (en)",
    status: "processing" as const,
    language: "en",
    accessTier: "open",
    processedChunks: 0,
    createdAt: "2026-05-20 16:12",
  },
  {
    id: "job-3",
    title: "Homebrew: Underdark Campaign Guide",
    status: "failed" as const,
    language: "ru",
    accessTier: "personal",
    processedChunks: 0,
    createdAt: "2026-05-20 15:45",
  },
  {
    id: "job-4",
    title: "Tasha's Cauldron of Everything (en)",
    status: "queued" as const,
    language: "en",
    accessTier: "premium",
    processedChunks: 0,
    createdAt: "2026-05-20 16:30",
  },
];

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

const STATUS_STYLES: Record<string, string> = {
  completed: "bg-success/15 text-success",
  processing: "bg-warning/15 text-warning",
  failed: "bg-danger/15 text-danger",
  queued: "bg-surface-light text-text-muted",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Завершён",
  processing: "Обработка",
  failed: "Ошибка",
  queued: "В очереди",
};

const CATEGORY_OPTIONS = [
  { value: "core_rules", label: "Core Rules", description: "Базовые правила" },
  { value: "official_supplement", label: "Official Supplement" },
  { value: "homebrew", label: "Homebrew" },
];

const EDITION_OPTIONS = [
  { value: "5.5e", label: "D&D 5.5e", description: "Правила 2024" },
  { value: "5e", label: "D&D 5e" },
];

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

const ACCESS_OPTIONS = [
  { value: "open", label: "Open", description: "Все пользователи" },
  { value: "premium", label: "Premium", description: "Подписчики" },
  { value: "personal", label: "Personal", description: "Только владелец" },
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

export default function MockAdminPage() {
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [category, setCategory] = useState("core_rules");
  const [edition, setEdition] = useState("5.5e");
  const [language, setLanguage] = useState("ru");
  const [accessTier, setAccessTier] = useState("open");
  const [users, setUsers] = useState(MOCK_USERS);

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    setUploading(true);
    setTimeout(() => {
      setUploading(false);
      setUploadDone(true);
      setTimeout(() => setUploadDone(false), 3000);
    }, 1500);
  }

  return (
    <div className="space-y-8">
      <nav className="flex items-center gap-2 text-sm text-text-muted">
        <Link href="/mock/search" className="hover:text-accent">
          Поиск
        </Link>
        <span>/</span>
        <span className="text-text-secondary">Админ · Загрузка</span>
      </nav>

      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
            Admin
          </span>
          <h1 className="text-2xl font-bold text-text-primary">Загрузка PDF</h1>
        </div>

        <form onSubmit={handleUpload} className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-semibold text-text-secondary">
              PDF файл
            </label>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <label className="cursor-pointer rounded-xl border border-dashed border-border bg-primary/40 px-6 py-4 text-center transition-colors hover:border-accent/40 hover:bg-primary/60">
                <input type="file" accept=".pdf" className="hidden" />
                <span className="block font-mono text-xs font-bold tracking-widest text-accent uppercase">
                  PDF
                </span>
                <p className="mt-2 text-sm text-text-muted">
                  Нажмите или перетащите файл
                </p>
                <p className="mt-1 text-xs text-text-muted">PDF, до 1 ГБ</p>
              </label>
              <div className="text-sm text-text-muted">
                <p>
                  Выбран: <span className="text-text-secondary">—</span>
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-text-secondary">
                Название *
              </span>
              <input
                type="text"
                placeholder="Player's Handbook 2024 (ru)"
                className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </label>
            <MockSelect
              label="Категория"
              value={category}
              options={CATEGORY_OPTIONS}
              onChange={setCategory}
            />
            <MockSelect
              label="Редакция"
              value={edition}
              options={EDITION_OPTIONS}
              onChange={setEdition}
            />
            <MockSelect
              label="Язык"
              value={language}
              options={LANGUAGE_OPTIONS}
              onChange={setLanguage}
            />
            <MockSelect
              label="Уровень доступа"
              value={accessTier}
              options={ACCESS_OPTIONS}
              onChange={setAccessTier}
            />
          </div>

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={uploading}
              className="rounded-xl bg-accent px-6 py-3 font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {uploading ? "Загрузка…" : "Загрузить и обработать"}
            </button>
            {uploadDone && (
              <span className="text-sm font-semibold text-success">
                Готово: файл загружен, обработка начата
              </span>
            )}
          </div>
        </form>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-text-primary">Задачи обработки</h2>
          <span className="text-sm text-text-muted">Обновляется каждые 10 сек</span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Источник</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Статус</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Чанки</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Дата</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Действия</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_JOBS.map((job) => (
                <tr key={job.id} className="border-b border-border-light transition-colors hover:bg-surface-light/50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-primary">{job.title}</p>
                    <div className="mt-1 flex gap-1.5">
                      <span className="rounded-full bg-surface-light px-1.5 py-0.5 text-[10px] text-text-muted">{job.language}</span>
                      <span className="rounded-full bg-surface-light px-1.5 py-0.5 text-[10px] text-text-muted">{job.accessTier}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[job.status]}`}>
                      {STATUS_LABELS[job.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {job.processedChunks > 0 ? job.processedChunks.toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap text-text-muted">{job.createdAt}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {job.status === "failed" && <button className="rounded-md border border-warning/40 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/10">Retry</button>}
                      {job.status === "completed" && <button className="rounded-md border border-accent/40 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">Reprocess</button>}
                      <button className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-text-primary">Права пользователей</h2>
            <p className="mt-1 text-sm text-text-muted">
              Mock-таблица: роли меняются локально без сохранения на сервере.
            </p>
          </div>
          <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
            {users.length} пользователя
          </span>
        </div>

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
