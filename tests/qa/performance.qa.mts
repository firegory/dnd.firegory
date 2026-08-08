import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { CompendiumReadService } from "../../src/server/compendium/read-service.ts";
import { IDS, isolatedDatabase, runProductionMigrations, seedAccessFixture } from "./postgres.mts";

const VOLUME_ROWS = threshold("QA_VOLUME_ROWS", 10_000, 1_000, 100_000);
const MAX_EXECUTION_MS = threshold("QA_MAX_QUERY_MS", 1_500, 1, 60_000);
const MAX_PLANNING_MS = threshold("QA_MAX_PLANNING_MS", 250, 1, 10_000);

test("QA integration: representative compendium volume records bounded EXPLAIN ANALYZE evidence", async (t) => {
  const db = await isolatedDatabase("performance");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  await seedAccessFixture(db.pool);

  const seedClient = await db.pool.connect();
  await seedClient.query("BEGIN");
  try {
    await seedClient.query("SET CONSTRAINTS ALL DEFERRED");
    await seedClient.query(
      `INSERT INTO compendium_entries(id,canonical_key,entry_type,edition)
       SELECT md5('qa-entry-'||n)::uuid, 'volume-spell-'||lpad(n::text,6,'0'), 'spell', '5.5e'
       FROM generate_series(1,$1) n`,
      [VOLUME_ROWS],
    );
    await seedClient.query(
      `INSERT INTO compendium_versions(id,entry_id,entry_type,edition,language,source_id,file_id,lifecycle,active_revision_id,published_at)
       SELECT md5('qa-version-'||n)::uuid,md5('qa-entry-'||n)::uuid,'spell','5.5e','en',$2,$3,'draft',md5('qa-revision-'||n)::uuid,NULL
       FROM generate_series(1,$1) n`,
      [VOLUME_ROWS, IDS.sources.open, "30000000-0000-4000-8000-000000000001"],
    );
    await seedClient.query(
      `INSERT INTO compendium_revisions(id,version_id,entry_type,revision_number,lifecycle,title,summary,body,published_at)
       SELECT md5('qa-revision-'||n)::uuid,md5('qa-version-'||n)::uuid,'spell',1,'draft','Volume Spell '||lpad(n::text,6,'0'),'Representative fixture','Deterministic body',NULL
       FROM generate_series(1,$1) n`,
      [VOLUME_ROWS],
    );
    await seedClient.query(
      `INSERT INTO compendium_names(version_id,entry_id,entry_type,edition,language,kind,name)
       SELECT md5('qa-version-'||n)::uuid,md5('qa-entry-'||n)::uuid,'spell','5.5e','en','slug','volume-spell-'||lpad(n::text,6,'0')
       FROM generate_series(1,$1) n`,
      [VOLUME_ROWS],
    );
    await seedClient.query(
      `INSERT INTO compendium_spells(revision_id,level,school,casting_time,range_text,duration_text,components,concentration,ritual)
       SELECT md5('qa-revision-'||n)::uuid,n%10,'evocation','1 action','60 feet','Instantaneous','V, S',false,false
       FROM generate_series(1,$1) n`,
      [VOLUME_ROWS],
    );
    await seedClient.query("UPDATE compendium_revisions SET lifecycle='published',published_at=now() WHERE id IN (SELECT md5('qa-revision-'||n)::uuid FROM generate_series(1,$1) n)", [VOLUME_ROWS]);
    await seedClient.query("UPDATE compendium_versions SET lifecycle='published',published_at=now() WHERE id IN (SELECT md5('qa-version-'||n)::uuid FROM generate_series(1,$1) n)", [VOLUME_ROWS]);
    await seedClient.query("COMMIT");
  } catch (error) {
    await seedClient.query("ROLLBACK");
    throw error;
  } finally {
    seedClient.release();
  }
  await db.pool.query("ANALYZE compendium_entries; ANALYZE compendium_versions; ANALYZE compendium_revisions; ANALYZE compendium_names");

  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const service = new CompendiumReadService({
    async query(sql: string, values: readonly unknown[] = []) {
      statements.push({ sql, values });
      return db.pool.query(sql, [...values]);
    },
  });
  const result = await service.listEntries(
    { role: "user", userId: IDS.users.regular },
    { edition: "5.5e", language: "en", entryType: "spell", limit: 50 },
  );
  assert.equal(result.count, VOLUME_ROWS + 1);
  assert.equal(result.entries.length, 50);

  const list = statements.find(({ sql }) => sql.includes("LIMIT $"));
  assert.ok(list, "the production list statement must be captured");
  const explained = await db.pool.query<{
    "QUERY PLAN": Array<{ Plan: Record<string, unknown>; "Planning Time": number; "Execution Time": number }>;
  }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${list.sql}`, [...list.values]);
  const evidence = explained.rows[0]?.["QUERY PLAN"]?.[0];
  assert.ok(evidence);
  assert.ok(evidence["Execution Time"] <= MAX_EXECUTION_MS, `execution ${evidence["Execution Time"]}ms exceeds ${MAX_EXECUTION_MS}ms`);
  assert.ok(evidence["Planning Time"] <= MAX_PLANNING_MS, `planning ${evidence["Planning Time"]}ms exceeds ${MAX_PLANNING_MS}ms`);
  assert.equal(containsNode(evidence.Plan, "Sort"), true, "plan must explain the deterministic title ordering");

  await mkdir("qa-artifacts", { recursive: true });
  await writeFile("qa-artifacts/compendium-list-plan.json", `${JSON.stringify({
    rows: VOLUME_ROWS,
    thresholds: { executionMs: MAX_EXECUTION_MS, planningMs: MAX_PLANNING_MS },
    measured: { executionMs: evidence["Execution Time"], planningMs: evidence["Planning Time"] },
    plan: evidence.Plan,
  }, null, 2)}\n`);
});

function threshold(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function containsNode(plan: Record<string, unknown>, nodeType: string): boolean {
  if (plan["Node Type"] === nodeType) return true;
  return Array.isArray(plan.Plans) && plan.Plans.some((child) => child && typeof child === "object" && containsNode(child as Record<string, unknown>, nodeType));
}
