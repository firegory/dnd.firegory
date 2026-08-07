import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CompendiumNotFoundError,
  CompendiumReadService,
} from "../../src/server/compendium/read-service.ts";
import {
  buildRetrievalAuthorizationFilter,
  sourceMatchesRetrievalAuthorizationFilter,
  type RetrievalUser,
  type SourceAccessMetadata,
} from "../../src/server/access/retrieval-filter.ts";

const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  entry: "10000000-0000-4000-8000-000000000002",
};

test("compendium list and count apply the centralized role matrix at the source boundary", async () => {
  const cases = [
    { user: { role: "user", userId: "regular" } as const, expected: ["open"], params: [] },
    { user: { role: "premium", userId: "owner" } as const, expected: ["open", "premium", "personal"], params: ["owner"] },
    { user: { role: "premium", userId: "nonowner" } as const, expected: ["open", "premium", "personal"], params: ["nonowner"] },
    { user: { role: "admin", userId: "admin" } as const, expected: [], params: [] },
  ];

  for (const roleCase of cases) {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const service = new CompendiumReadService({
      async query(sql: string, values: readonly unknown[] = []) {
        statements.push({ sql, values });
        return { rows: sql.includes("count(*)") ? [{ count: "0" }] : [] } as never;
      },
    });

    assert.deepEqual(await service.listEntries(roleCase.user), { entries: [], count: 0 });
    assert.equal(statements.length, 2);
    for (const { sql, values } of statements) {
      assert.match(sql, /JOIN sources s ON s\.id = v\.source_id[\s\S]*WHERE/);
      assert.match(sql, /v\.lifecycle = 'published'/);
      assert.match(sql, /r\.lifecycle = 'published'/);
      assert.match(sql, /selected_versions AS \([\s\S]*source_rank = 1/);
      for (const tier of roleCase.expected) assert.match(sql, new RegExp(`s\\.access_tier = '${tier}'`));
      if (roleCase.user.role === "admin") assert.doesNotMatch(sql, /s\.access_tier/);
      for (const value of roleCase.params) assert.ok(values.includes(value));
    }
  }
});

test("grouped entries select aliases and protected fields only from the chosen accessible version", async () => {
  let listSql = "";
  const service = new CompendiumReadService({
    async query(sql: string) {
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] } as never;
      listSql = sql;
      return { rows: [] } as never;
    },
  });

  await service.listEntries({ role: "user", userId: "regular" });
  assert.match(listSql, /FROM selected_versions av/);
  assert.match(listSql, /n\.version_id = av\.version_id/);
  assert.match(listSql, /av\.title, av\.summary/);
  assert.doesNotMatch(listSql, /av\.body|av\.extension_data/);
  assert.doesNotMatch(listSql, /(?:max|min|string_agg|array_agg)\s*\(\s*av\.(?:title|summary|body|extension_data)/i);
});

test("inaccessible UUIDs, slugs, and aliases have the same not-found result", async () => {
  const statements: string[] = [];
  const service = new CompendiumReadService({
    async query(sql: string) {
      statements.push(sql);
      return { rows: [] } as never;
    },
  });

  for (const lookup of [
    service.getEntry({ role: "user", userId: "regular" }, ids.entry),
    service.getEntry({ role: "user", userId: "regular" }, "protected-spell"),
    service.resolveAlias({ role: "user", userId: "regular" }, "Protected Spell"),
  ]) {
    await assert.rejects(lookup, CompendiumNotFoundError);
  }
  assert.equal(statements.length, 3);
  for (const sql of statements) assert.match(sql, /s\.access_tier = 'open'/);
  assert.match(statements[0], /JOIN selected_versions target/);
  assert.match(statements[0], /JOIN accessible_versions evidence ON evidence\.version_id = provenance\.evidence_version_id/);
  assert.doesNotMatch(statements[0], /NOT EXISTS[\s\S]*provenance\.relation_id/);
  assert.match(statements[0], /FROM accessible_versions source_version/);
  assert.match(statements[0], /citation\.version_id = av\.version_id/);
  assert.match(statements[0], /citation\.revision_id = av\.revision_id/);
  assert.match(statements[0], /citation\.source_id = av\.source_id/);
  assert.match(statements[0], /citation\.file_id = av\.file_id/);
  assert.match(statements[0], /LEFT JOIN chunks evidence ON evidence\.id = citation\.chunk_id/);
  assert.match(statements[0], /'page', evidence\.page_number/);
  assert.match(statements[0], /'section', evidence\.section_heading/);
});

test("relation visibility fails closed across provenance states and every role", () => {
  const open = provenance({ accessTier: "open" });
  const premium = provenance({ accessTier: "premium", shared: true });
  const ownerPersonal = provenance({ accessTier: "personal", ownerUserId: "owner" });
  const deletedOpen = { ...open, deleted: true };
  const roles = [
    { name: "user", user: { role: "user", userId: "user" } as const },
    { name: "premium owner", user: { role: "premium", userId: "owner" } as const },
    { name: "premium non-owner", user: { role: "premium", userId: "other" } as const },
    { name: "admin", user: { role: "admin", userId: "admin" } as const },
  ];

  for (const { name, user } of roles) {
    assert.equal(relationVisible([], user), false, `${name}: zero provenance must be hidden`);
    assert.equal(relationVisible([deletedOpen], user), false, `${name}: deleted provenance must be hidden`);
    assert.equal(relationVisible([ownerPersonal], user), name === "premium owner" || name === "admin", `${name}: inaccessible-only provenance`);
    assert.equal(relationVisible([ownerPersonal, open], user), true, `${name}: mixed provenance with an accessible link`);
    assert.equal(relationVisible([premium], user), name !== "user", `${name}: shared premium provenance`);
  }
});

test("relation SQL requires affirmative non-deleted provenance for every role", async () => {
  const roles: readonly RetrievalUser[] = [
    { role: "user", userId: "user" },
    { role: "premium", userId: "owner" },
    { role: "premium", userId: "nonowner" },
    { role: "admin", userId: "admin" },
  ];

  for (const user of roles) {
    let statement = "";
    const service = new CompendiumReadService({
      async query(sql: string) {
        statement = sql;
        return { rows: [] } as never;
      },
    });
    await assert.rejects(service.getEntry(user, ids.entry), CompendiumNotFoundError);
    assert.match(statement, /AND EXISTS \([\s\S]*provenance\.relation_id = relation\.id/);
    assert.doesNotMatch(statement, /NOT EXISTS[\s\S]*provenance\.relation_id/);
    assert.match(statement, /s\.deleted_at IS NULL/);
    assert.match(statement, /f\.deleted_at IS NULL/);
    if (user.role === "admin") {
      assert.doesNotMatch(statement, /s\.access_tier/);
    } else {
      assert.match(statement, /s\.access_tier = 'open'/);
    }
  }
});

test("detail route serializes the filtered service result and relations default empty", async () => {
  const route = await readFile(new URL("../../src/app/api/compendium/entries/[identifier]/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../../src/server/compendium/read-service.ts", import.meta.url), "utf8");
  assert.match(route, /NextResponse\.json\(await new CompendiumReadService\(\)\.getEntry/);
  assert.match(service, /coalesce\(\([\s\S]*\), '\[\]'::jsonb\) AS relations/);
});

test("public source lookup is SQL-filtered and omits administrative metadata", async () => {
  let statement = "";
  const service = new CompendiumReadService({
    async query(sql: string) {
      statement = sql;
      return { rows: [{
        id: ids.source,
        title: "Open Rules",
        category: "core_rules",
        edition: "5.5e",
        language: "en",
        publication_code: "SRD",
        publication_title: "Open Rules",
        publisher: "Publisher",
        release_year: 2024,
        publication_revision: null,
        external_origin_url: "https://example.test/open-rules",
        attribution: "Open Rules",
        license: "CC-BY",
        access_tier: "personal",
        owner_user_id: "secret-owner",
        metadata: { secret: true },
        storage_path: "/secret/path",
      }] } as never;
    },
  });

  const source = await service.getSource({ role: "user", userId: "regular" }, ids.source);
  assert.match(statement, /s\.access_tier = 'open'/);
  assert.doesNotMatch(statement, /owner_user_id|metadata|storage_path|created_by_user_id/);
  assert.equal("accessTier" in source, false);
  assert.equal("ownerUserId" in source, false);
  assert.equal("metadata" in source, false);
  assert.equal(source.publication.originUrl, "https://example.test/open-rules");
});

test("citation cards expose admin source links only in the admin branch", async () => {
  const source = await readFile(new URL("../../src/app/search/search-form.tsx", import.meta.url), "utf8");
  assert.match(source, /isAdmin \? \([\s\S]*href={`\/admin\/sources\/\$\{citation\.sourceId\}`}/);
  assert.match(source, /<span className="font-semibold text-accent">\{citation\.sourceTitle\}<\/span>/);
});

test("both citation preview lookup paths reuse the centralized source predicate", async () => {
  const [source, route] = await Promise.all([
    readFile(new URL("../../src/server/citations/preview.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/api/citations/preview/route.ts", import.meta.url), "utf8"),
  ]);
  assert.equal((source.match(/buildRetrievalAuthorizationFilter\(user\)/g) ?? []).length, 2);
  assert.equal((source.match(/buildSourceAccessSql\(filter\)/g) ?? []).length, 2);
  assert.match(source, /getAuthorizedCitationPreviewFile[\s\S]*WHERE \$\{accessFilter\.sql\}/);
  assert.match(source, /lookupChunkBbox[\s\S]*AND \$\{accessFilter\.sql\}/);
  assert.equal((route.match(/hasPageFallback\(url\).*handlePagePreview\(url, user\)/g) ?? []).length, 2);
});

type Provenance = Readonly<{ source: SourceAccessMetadata; deleted: boolean }>;

function provenance(source: SourceAccessMetadata): Provenance {
  return { source, deleted: false };
}

function relationVisible(links: readonly Provenance[], user: RetrievalUser): boolean {
  const filter = buildRetrievalAuthorizationFilter(user);
  return links.some((link) => !link.deleted && sourceMatchesRetrievalAuthorizationFilter(link.source, filter));
}
