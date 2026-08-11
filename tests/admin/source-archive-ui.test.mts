import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source detail exposes a bilingual, explicitly confirmed archive danger zone", async () => {
  const [page, archiveUi, editor, i18n] = await Promise.all([
    readFile("src/app/admin/sources/[sourceId]/page.tsx", "utf8"),
    readFile("src/app/admin/sources/[sourceId]/archive-source.tsx", "utf8"),
    readFile("src/app/admin/sources/[sourceId]/source-metadata-editor.tsx", "utf8"),
    readFile("src/components/ui/i18n.tsx", "utf8"),
  ]);

  assert.match(page, /<ArchiveSource sourceId=\{source\.id\} title=\{source\.title\}/);
  assert.match(archiveUi, /method: "DELETE"/);
  assert.match(archiveUi, /JSON\.stringify\(\{ confirmationTitle \}\)/);
  assert.match(archiveUi, /disabled=\{confirmationTitle !== title \|\| status === "archiving"\}/);
  assert.match(archiveUi, /router\.replace\("\/admin\/sources"\)/);
  assert.match(archiveUi, /role="alert"/);
  assert.match(archiveUi, /SOURCE_HAS_ACTIVE_JOBS/);
  assert.match(archiveUi, /SOURCE_MANAGED_BY_NFS/);
  assert.match(editor, /router\.refresh\(\)/);
  assert.match(i18n, /archiveSource: "Архивировать источник"/);
  assert.match(i18n, /archiveSource: "Archive source"/);
  assert.match(i18n, /Все файлы, задачи, поколения и данные будут сохранены/);
  assert.match(i18n, /All files, jobs, generations, and data will be preserved/);
  assert.match(i18n, /archiveSourceActiveJobs: "Дождитесь завершения/);
  assert.match(i18n, /archiveSourceActiveJobs: "Wait for active processing/);
});

test("job table no longer exposes the retired destructive source action", async () => {
  const jobsTable = await readFile("src/app/admin/ingestion/jobs-table.tsx", "utf8");
  assert.doesNotMatch(jobsTable, /handleDelete|onDelete|finalDeleteConfirm/);
});
