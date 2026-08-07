import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const ROOT = new URL("../../", import.meta.url);

describe("compendium print treatment", () => {
  it("removes interactive chrome and wraps wide tables", async () => {
    const css = await readFile(new URL("src/app/globals.css", ROOT), "utf8");

    assert.match(css, /@media print/);
    assert.match(css, /\.app-content form,/);
    assert.match(css, /button:not\(\.print-content\)/);
    assert.match(css, /\.print-action/);
    assert.match(css, /table-layout: fixed/);
    assert.match(css, /overflow-wrap: anywhere/);
  });

  it("marks action columns for print removal and citation text for preservation", async () => {
    const [jobsTable, usersPage, searchForm] = await Promise.all([
      readFile(new URL("src/app/admin/ingestion/jobs-table.tsx", ROOT), "utf8"),
      readFile(new URL("src/app/admin/users/page.tsx", ROOT), "utf8"),
      readFile(new URL("src/app/search/search-form.tsx", ROOT), "utf8"),
    ]);

    assert.match(jobsTable, /<th className="print-action/);
    assert.match(jobsTable, /<td className="print-action[^>]*>\s*<Actions/);
    assert.match(usersPage, /<th className="print-action/);
    assert.match(usersPage, /<td className="print-action[^>]*>\s*<form/);
    assert.match(searchForm, /className="print-content/);
  });

  it("keeps guide citations printable and collapses tiles on mobile", async () => {
    const css = await readFile(new URL("src/app/globals.css", ROOT), "utf8");
    assert.match(css, /@media \(max-width: 39\.999rem\)[\s\S]*\.guide-tile-grid,[\s\S]*grid-template-columns: 1fr/);
    assert.match(css, /@media print[\s\S]*\.guide-citation details:not\(\[open\]\)[\s\S]*display: block/);
    assert.match(css, /@media print[\s\S]*\.guide-citation summary[\s\S]*display: none/);
  });
});
