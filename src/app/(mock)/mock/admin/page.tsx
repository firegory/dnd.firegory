"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

const MOCK_JOBS = [
  {
    id: "job-1",
    title: "Player's Handbook 2024 (ru)",
    status: "completed" as const,
    edition: "5.5e",
    language: "ru",
    category: "core_rules",
    accessTier: "open",
    pages: 387,
    chunks: 2572,
    createdAt: "2026-05-20 14:32",
    completedAt: "2026-05-20 14:35",
  },
  {
    id: "job-2",
    title: "Monster Manual 2024 (en)",
    status: "processing" as const,
    edition: "5.5e",
    language: "en",
    category: "core_rules",
    accessTier: "open",
    pages: 0,
    chunks: 0,
    createdAt: "2026-05-20 16:12",
    completedAt: null,
  },
  {
    id: "job-3",
    title: "Homebrew: Underdark Campaign Guide",
    status: "failed" as const,
    edition: "5e",
    language: "ru",
    category: "homebrew",
    accessTier: "personal",
    pages: 0,
    chunks: 0,
    error: "Missing PDF text extraction dependency: pdftotext (install poppler-utils)",
    createdAt: "2026-05-20 15:45",
    completedAt: null,
  },
  {
    id: "job-4",
    title: "Tasha's Cauldron of Everything (en)",
    status: "queued" as const,
    edition: "5e",
    language: "en",
    category: "official_supplement",
    accessTier: "premium",
    pages: 0,
    chunks: 0,
    createdAt: "2026-05-20 16:30",
    completedAt: null,
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

export default function MockAdminPage() {
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);

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
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm text-text-muted">
        <Link href="/mock" className="hover:text-accent">
          Главная
        </Link>
        <span>/</span>
        <span className="text-text-secondary">Админ · Загрузка</span>
      </nav>

      {/* Upload form */}
      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
            Admin
          </span>
          <h1 className="text-2xl font-bold text-text-primary">
            Загрузка PDF
          </h1>
        </div>

        <form onSubmit={handleUpload} className="space-y-5">
          {/* File input */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-text-secondary">
              PDF файл
            </label>
            <div className="flex items-center gap-4">
              <label className="cursor-pointer rounded-xl border border-dashed border-border bg-primary/40 px-6 py-4 text-center transition-colors hover:border-accent/40 hover:bg-primary/60">
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                />
                <span className="text-3xl">📄</span>
                <p className="mt-2 text-sm text-text-muted">
                  Нажмите или перетащите файл
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  PDF, до 200 МБ
                </p>
              </label>
              <div className="text-sm text-text-muted">
                <p>Выбран: <span className="text-text-secondary">—</span></p>
              </div>
            </div>
          </div>

          {/* Metadata fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-text-secondary">
                Название *
              </span>
              <input
                type="text"
                placeholder="Player's Handbook 2024 (ru)"
                className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-text-secondary">
                Категория
              </span>
              <select className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent">
                <option value="core_rules">Core Rules</option>
                <option value="official_supplement">Official Supplement</option>
                <option value="homebrew">Homebrew</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-text-secondary">
                Редакция
              </span>
              <select className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent">
                <option value="5.5e">D&D 5.5e (2024)</option>
                <option value="5e">D&D 5e</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-text-secondary">
                Язык
              </span>
              <select className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent">
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-text-secondary">
                Уровень доступа
              </span>
              <select className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent">
                <option value="open">Open — все пользователи</option>
                <option value="premium">Premium — подписчики</option>
                <option value="personal">Personal — только я</option>
              </select>
            </label>
          </div>

          {/* Submit */}
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
                ✓ Файл загружен, обработка начата
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Jobs table */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-text-primary">
            Задачи обработки
          </h2>
          <span className="text-sm text-text-muted">
            Обновляется каждые 10 сек
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Источник
                </th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Статус
                </th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Редакция
                </th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Чанки
                </th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Дата
                </th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Действия
                </th>
              </tr>
            </thead>
            <tbody>
              {MOCK_JOBS.map((job) => (
                <tr
                  key={job.id}
                  className="border-b border-border-light transition-colors hover:bg-surface-light/50"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-primary">
                      {job.title}
                    </p>
                    <div className="mt-1 flex gap-1.5">
                      <span className="rounded-full bg-surface-light px-1.5 py-0.5 text-[10px] text-text-muted">
                        {job.language}
                      </span>
                      <span className="rounded-full bg-surface-light px-1.5 py-0.5 text-[10px] text-text-muted">
                        {job.accessTier}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[job.status]}`}
                    >
                      {STATUS_LABELS[job.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {job.edition}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {job.chunks > 0 ? job.chunks.toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-text-muted">
                    {job.createdAt}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {job.status === "failed" && (
                        <button className="rounded-md border border-warning/40 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/10">
                          Retry
                        </button>
                      )}
                      {job.status === "completed" && (
                        <button className="rounded-md border border-accent/40 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                          Reprocess
                        </button>
                      )}
                      <button className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10">
                        Delete
                      </button>
                    </div>
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
