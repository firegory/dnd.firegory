import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { SpellReadService } from "../../src/server/compendium/spell-read-service.ts";
import { IDS, isolatedDatabase, runProductionMigrations, seedAccessFixture } from "./postgres.mts";

const VOLUME_ROWS = threshold("QA_VOLUME_ROWS", 10_000, 10_000, 100_000);
const MAX_EXECUTION_MS = threshold("QA_MAX_QUERY_MS", 1_500, 1, 60_000);
const MAX_PLANNING_MS = threshold("QA_MAX_PLANNING_MS", 250, 1, 10_000);

test("QA integration: mixed representative corpus records bounded list, count, and alias plans", async (t) => {
  const db = await isolatedDatabase("performance");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  await seedAccessFixture(db.pool);

  await db.pool.query(
    `INSERT INTO nfs_index_entries(
       id,repository_id,entry_id,revision_id,content_hash,entry_type,name,aliases,typed_fields,
       plain_text,canonical_payload,source_id,file_id,generation_id,document_id,lifecycle,edition,language)
     SELECT
       md5('volume-id-'||n)::uuid,
       'qa-fixture',
       'volume-'||(ARRAY['spell','feat','item','glossary'])[(n%4)+1]||'-'||lpad(n::text,6,'0'),
       'rev-'||repeat(md5('volume-revision-'||n),2),
       'sha256:'||repeat(md5('volume-content-'||n),2),
       (ARRAY['spell','feat','item','glossary'])[(n%4)+1],
       'Volume Entry '||lpad(n::text,6,'0'),
       jsonb_build_array('Volume Alias '||n,'Shared Alias '||(n%100)),
       CASE WHEN n%4=0 THEN jsonb_build_array(
         jsonb_build_object('key','level','value',n%10),
         jsonb_build_object('key','school','value',(ARRAY['evocation','abjuration','illusion'])[(n%3)+1]),
         jsonb_build_object('key','casting-time','value','1 action'),
         jsonb_build_object('key','range','value',(30+n%90)||' feet'),
          jsonb_build_object('key','duration','value','Instantaneous'),
          jsonb_build_object('key','components','value','V, S'),
         jsonb_build_object('key','classes','value',jsonb_build_array('class:'||(n%20))),
         jsonb_build_object('key','concentration','value',n%2=0),
         jsonb_build_object('key','ritual','value',n%3=0)
       ) ELSE jsonb_build_array(jsonb_build_object('key','category','value','volume-'||(n%12))) END,
       'Representative searchable text token-'||(n%200)||' for mixed compendium entry '||n,
       jsonb_build_object('citations',jsonb_build_array(jsonb_build_object(
         'citationId','volume-citation-'||n,'quote','Representative quote '||n,'section','Volume evidence','page',(n%300)+1))),
       ('20000000-0000-4000-8000-00000000000'||((n%5)+1))::uuid,
       ('30000000-0000-4000-8000-00000000000'||((n%5)+1))::uuid,
       ('40000000-0000-4000-8000-00000000000'||((n%5)+1))::uuid,
       ('64000000-0000-4000-8000-00000000000'||((n%5)+1))::uuid,
       'active',
       CASE WHEN n%5=4 THEN '5e'::source_edition ELSE '5.5e'::source_edition END,
       'en'
     FROM generate_series(1,$1) n`,
    [VOLUME_ROWS],
  );
  await db.pool.query("ANALYZE nfs_index_entries; ANALYZE sources; ANALYZE files");

  const mix = await db.pool.query<{ types: string; sources: string; aliases: string; citations: string; searchable: string }>(
    `SELECT count(DISTINCT entry_type)::text AS types,count(DISTINCT source_id)::text AS sources,
            count(*) FILTER (WHERE jsonb_array_length(aliases)>0)::text AS aliases,
            count(*) FILTER (WHERE jsonb_array_length(canonical_payload->'citations')>0)::text AS citations,
            count(*) FILTER (WHERE plain_text LIKE '%searchable text%')::text AS searchable
     FROM nfs_index_entries WHERE repository_id='qa-fixture' AND entry_id LIKE 'volume-%'`,
  );
  assert.deepEqual(mix.rows[0], { types: "4", sources: "5", aliases: String(VOLUME_ROWS), citations: String(VOLUME_ROWS), searchable: String(VOLUME_ROWS) });

  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const service = new SpellReadService({
    async query(sql: string, values: readonly unknown[] = []) {
      statements.push({ sql, values });
      return db.pool.query(sql, [...values]);
    },
  });
  const user = { role: "user" as const, userId: IDS.users.regular };
  const result = await service.list(user, { edition: "5.5e", language: "en", limit: 50 });
  assert.equal(result.count, Math.floor(VOLUME_ROWS / 20) + 1, "only open, 2024 spell rows plus the baseline spell are visible");
  assert.equal(result.spells.length, 50);
  const alias = await service.get(user, "Volume Alias 20", { edition: "5.5e", language: "en" });
  assert.equal(alias.id, "volume-spell-000020");

  const plans = [
    ["spell-list", statements.find(({ sql }) => sql.includes("ORDER BY spell.sort_title"))],
    ["spell-count", statements.find(({ sql }) => sql.includes("count(*)::text"))],
    ["spell-alias", [...statements].reverse().find(({ sql }) => sql.includes("jsonb_array_elements_text(spell.aliases)"))],
  ] as const;
  await mkdir("qa-artifacts", { recursive: true });
  for (const [name, statement] of plans) {
    assert.ok(statement, `${name} production query must be captured`);
    const explained = await db.pool.query<{
      "QUERY PLAN": Array<{ Plan: Record<string, unknown>; "Planning Time": number; "Execution Time": number }>;
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, [...statement.values]);
    const evidence = explained.rows[0]?.["QUERY PLAN"]?.[0];
    assert.ok(evidence);
    assert.ok(evidence["Execution Time"] <= MAX_EXECUTION_MS, `${name} execution ${evidence["Execution Time"]}ms exceeds ${MAX_EXECUTION_MS}ms`);
    assert.ok(evidence["Planning Time"] <= MAX_PLANNING_MS, `${name} planning ${evidence["Planning Time"]}ms exceeds ${MAX_PLANNING_MS}ms`);
    assertNoPathologicalScan(evidence.Plan, VOLUME_ROWS, name);
    assert.ok(Number(evidence.Plan["Actual Rows"] ?? 0) >= 1, `${name} plan must return rows`);
    await writeFile(`qa-artifacts/${name}-plan.json`, `${JSON.stringify({
      rows: VOLUME_ROWS,
      thresholds: { executionMs: MAX_EXECUTION_MS, planningMs: MAX_PLANNING_MS },
      measured: { executionMs: evidence["Execution Time"], planningMs: evidence["Planning Time"] },
      plan: evidence.Plan,
    }, null, 2)}\n`);
  }
});

function threshold(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function assertNoPathologicalScan(plan: Record<string, unknown>, rows: number, queryName: string): void {
  if (plan["Node Type"] === "Seq Scan" && plan["Relation Name"] === "nfs_index_entries") {
    const visited = Number(plan["Actual Rows"] ?? 0) + Number(plan["Rows Removed by Filter"] ?? 0);
    const returned = Number(plan["Actual Rows"] ?? 0);
    assert.ok(!(visited >= rows * 0.9 && returned < rows * 0.01), `${queryName} pathologically scans nearly all indexed entries to return under 1%`);
  }
  if (Array.isArray(plan.Plans)) {
    for (const child of plan.Plans) if (child && typeof child === "object") assertNoPathologicalScan(child as Record<string, unknown>, rows, queryName);
  }
}
