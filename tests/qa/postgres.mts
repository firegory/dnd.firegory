import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { Client, Pool, type PoolClient } from "pg";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";
import { createSessionToken, hashSessionToken } from "../../src/server/auth/session-token.ts";

export const IDS = {
  users: {
    regular: "10000000-0000-4000-8000-000000000001",
    premium: "10000000-0000-4000-8000-000000000002",
    owner: "10000000-0000-4000-8000-000000000003",
    admin: "10000000-0000-4000-8000-000000000004",
    empty: "10000000-0000-4000-8000-000000000005",
  },
  sources: {
    open: "20000000-0000-4000-8000-000000000001",
    premium: "20000000-0000-4000-8000-000000000002",
    personal: "20000000-0000-4000-8000-000000000003",
    otherPersonal: "20000000-0000-4000-8000-000000000004",
    legacyEdition: "20000000-0000-4000-8000-000000000005",
  },
  browserImportRun: "70000000-0000-4000-8000-000000000001",
} as const;

export type IsolatedDatabase = Readonly<{
  databaseName: string;
  url: string;
  pool: Pool;
  cleanup(): Promise<void>;
}>;

export function requireDatabaseUrl(): string {
  const value = process.env.QA_DATABASE_URL?.trim();
  if (!value) throw new Error("QA_DATABASE_URL is required; live PostgreSQL QA never skips.");
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("QA_DATABASE_URL must use postgres:// or postgresql://.");
  }
  return value;
}

export async function isolatedDatabase(label: string): Promise<IsolatedDatabase> {
  const baseUrl = requireDatabaseUrl();
  const databaseName = `qa_${label.replaceAll(/[^a-z0-9]/gi, "_").toLowerCase()}_${randomUUID().replaceAll("-", "")}`;
  assertQaDatabase(databaseName);
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await assertPostgresMajor(admin);
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url = databaseUrlForDatabase(baseUrl, databaseName);
  const pool = new Pool({ connectionString: url, max: 4 });
  let cleanupPromise: Promise<void> | undefined;
  return {
    databaseName,
    url,
    pool,
    async cleanup() {
      cleanupPromise ??= closeIsolatedDatabase(pool, admin, databaseName);
      await cleanupPromise;
    },
  };
}

async function closeIsolatedDatabase(pool: Pool, admin: Client, databaseName: string): Promise<void> {
  const errors: unknown[] = [];
  try {
    // Pool.end waits for checked-out clients and closes every owned socket.
    await pool.end();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await admin.end();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Failed to close isolated QA database ${databaseName}.`);
}

export function databaseUrlForDatabase(baseUrl: string, databaseName: string): string {
  assertQaDatabase(databaseName);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete("options");
  return url.toString();
}

export function assertQaDatabase(databaseName: string): void {
  assert.match(databaseName, /^qa_[a-z0-9_]+$/, "QA databases must start with qa_ and contain only lowercase letters, digits, and underscores");
}

export async function assertPostgresMajor(client: Pick<Client, "query">): Promise<void> {
  const version = await client.query<{ major: string }>("SELECT current_setting('server_version_num')::integer / 10000 AS major");
  assert.equal(Number(version.rows[0]?.major), 16, "QA requires PostgreSQL major version 16");
}

export async function assertPostgresRuntime(client: Pick<Client, "query">): Promise<void> {
  await assertPostgresMajor(client);
  const vector = await client.query<{ version: string }>("SELECT extversion AS version FROM pg_extension WHERE extname = 'vector'");
  assert.ok(vector.rows[0]?.version, "QA requires the pgvector extension to be preinstalled");
  const distance = await client.query<{ distance: number }>("SELECT '[1,0]'::vector <=> '[0,1]'::vector AS distance");
  assert.equal(distance.rows[0]?.distance, 1);
}

export async function runProductionMigrations(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/migrate.mts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Migration runner failed (${signal ?? code}).`)));
  });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertPostgresRuntime(client);
  } finally {
    await client.end();
  }
}

export async function applyMigrationPrefix(client: PoolClient, through: string): Promise<void> {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const filename of MIGRATION_FILENAMES) {
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [filename]);
    if (applied.rowCount) {
      if (filename === through) return;
      continue;
    }
    const sql = await readFile(`migrations/${filename}`, "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    if (filename === through) return;
  }
  throw new Error(`Unknown migration boundary: ${through}`);
}

export async function seedAccessFixture(database: Pool | PoolClient, options: Readonly<{
  includeReview?: boolean;
  storageRoot?: string;
  fileChecksumSha256?: string;
}> = {}): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};
  const ownsClient = database instanceof Pool;
  const client = ownsClient ? await database.connect() : database;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const [name, id] of Object.entries(IDS.users)) {
      const role = name === "admin" ? "admin" : name === "premium" || name === "owner" ? "premium" : "user";
      await client.query(
        "INSERT INTO users(id,email,password_hash,role,display_name) VALUES ($1,$2,'qa-not-a-login-password',$3,$4)",
        [id, `${name}@qa.invalid`, role, `QA ${name}`],
      );
      const token = createSessionToken();
      tokens[name] = token;
      await client.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')", [id, hashSessionToken(token)]);
    }

    const sourceRows = [
      [IDS.sources.open, "Open 2024 Rules", "core_rules", "5.5e", "open", false, null, 100],
      [IDS.sources.premium, "Premium 2024 Rules", "official_supplement", "5.5e", "premium", true, null, 90],
      [IDS.sources.personal, "Owner Notes", "homebrew", "5.5e", "personal", false, IDS.users.owner, 80],
      [IDS.sources.otherPersonal, "Other Notes", "homebrew", "5.5e", "personal", false, IDS.users.premium, 70],
      [IDS.sources.legacyEdition, "Open 2014 Rules", "core_rules", "5e", "open", false, null, 60],
    ] as const;
    for (const [id, title, category, edition, tier, shared, owner, priority] of sourceRows) {
      await client.query(
        `INSERT INTO sources(id,title,category,edition,language,access_tier,shared,owner_user_id,canonical_source_id,publication_title,publication_code,publisher,release_year,source_priority,canonical_book_id,attribution,license)
         VALUES ($1,$2,$3,$4,'en',$5,$6,$7,$8,$2,$9,'QA Publisher',$10,$11,$12,'QA fixture','CC-BY-4.0')`,
        [id, title, category, edition, tier, shared, owner, `qa-source-${id.at(-1)}`, `QA${priority}`, edition === "5.5e" ? 2024 : 2014, priority, `qa-book-${id.at(-1)}`],
      );
      const suffix = id.at(-1)!;
      const fileId = `30000000-0000-4000-8000-00000000000${suffix}`;
      const generationId = `40000000-0000-4000-8000-00000000000${suffix}`;
      const entryId = `50000000-0000-4000-8000-00000000000${suffix}`;
      const versionId = `60000000-0000-4000-8000-00000000000${suffix}`;
      const revisionId = `61000000-0000-4000-8000-00000000000${suffix}`;
      const chunkId = `62000000-0000-4000-8000-00000000000${suffix}`;
      const documentId = `64000000-0000-4000-8000-00000000000${suffix}`;
      const storagePath = `${options.storageRoot ?? "/tmp/dnd-firegory-qa-storage"}/originals/${id}/${fileId}.pdf`;
      await client.query(
        `INSERT INTO files(id,source_id,original_filename,mime_type,checksum_sha256,byte_size,storage_path)
         VALUES ($1,$2,$3,'application/pdf',$4,128,$5)`,
        [fileId, id, `qa-${suffix}.pdf`, options.fileChecksumSha256 ?? suffix.repeat(64), storagePath],
      );
      await client.query(
        "INSERT INTO ingestion_generations(id,source_id,file_id,status,activated_at) VALUES ($1,$2,$3,'active',now())",
        [generationId, id, fileId],
      );
      await client.query("UPDATE files SET active_generation_id=$2 WHERE id=$1", [fileId, generationId]);
      await client.query(
        "INSERT INTO documents(id,source_id,file_id,generation_id,title,text) VALUES ($1,$2,$3,$4,$5,$6)",
        [documentId, id, fileId, generationId, title, `Indexed document for ${title}`],
      );
      await client.query(
        `INSERT INTO chunks(id,source_id,file_id,generation_id,chunk_index,text,quote_text,section_heading,page_number)
         VALUES ($1,$2,$3,$4,0,$5,$5,'QA evidence',1)`,
        [chunkId, id, fileId, generationId, `Evidence quote for ${title}`],
      );
      await client.query("INSERT INTO compendium_entries(id,canonical_key,entry_type,edition) VALUES ($1,$2,'spell',$3)", [entryId, `qa-spell-${suffix}`, edition]);
      await client.query(
        `INSERT INTO compendium_versions(id,entry_id,entry_type,edition,language,source_id,file_id,lifecycle,active_revision_id,editor_head_revision_id,published_at)
         VALUES ($1,$2,'spell',$3,'en',$4,$5,'draft',$6,$6,NULL)`,
        [versionId, entryId, edition, id, fileId, revisionId],
      );
      await client.query(
        `INSERT INTO compendium_revisions(id,version_id,entry_type,revision_number,lifecycle,title,summary,body,published_at)
         VALUES ($1,$2,'spell',1,'draft',$3,$4,$5,NULL)`,
        [revisionId, versionId, `QA Spell ${suffix}`, `${title} summary`, `First paragraph for ${title}.\n\nPrintable second paragraph.`],
      );
      await client.query("INSERT INTO compendium_names(version_id,entry_id,entry_type,edition,language,kind,name) VALUES ($1,$2,'spell',$3,'en','slug',$4)", [versionId, entryId, edition, `qa-spell-${suffix}`]);
      await client.query(
        `INSERT INTO compendium_spells(revision_id,level,school,casting_time,range_text,duration,components,concentration,ritual)
         VALUES ($1,1,'evocation','1 action','60 feet','Instantaneous','V, S',false,false)`,
        [revisionId],
      );
      await client.query(
        `INSERT INTO compendium_citations(revision_id,version_id,source_id,file_id,generation_id,chunk_id,kind,field_path,block_order,quote,quote_span_start,quote_span_end)
         VALUES ($1,$2,$3,$4,$5,$6,'block',NULL,0,$7,0,char_length($7))`,
        [revisionId, versionId, id, fileId, generationId, chunkId, `Evidence quote for ${title}`],
      );
      await client.query("UPDATE compendium_revisions SET lifecycle='published',published_at=now() WHERE id=$1", [revisionId]);
      await client.query("UPDATE compendium_versions SET lifecycle='published',published_at=now() WHERE id=$1", [versionId]);
      await client.query(
        "INSERT INTO nfs_index_managed_sources(source_id,repository_id,canonical_source_id) VALUES ($1,'qa-fixture',$2)",
        [id, `qa-source-${suffix}`],
      );
      await client.query(
        "INSERT INTO nfs_index_managed_files(file_id,source_id,repository_id,canonical_file_id,last_nfs_generation_id) VALUES ($1,$2,'qa-fixture',$3,$4)",
        [fileId, id, `qa-file-${suffix}`, generationId],
      );
      const typedFields = [
        { key: "level", value: 1 }, { key: "school", value: "evocation" },
        { key: "casting-time", value: "1 action" }, { key: "range", value: "60 feet" },
        { key: "duration", value: "Instantaneous" }, { key: "components", value: "V, S" },
        { key: "classes", value: ["class:17"] }, { key: "concentration", value: false }, { key: "ritual", value: false },
      ];
      const canonicalPayload = {
        citations: [{ citationId: `qa-citation-${suffix}`, quote: `Evidence quote for ${title}`, section: "QA evidence", page: 1 }],
      };
      await client.query(
        `INSERT INTO nfs_index_entries(id,repository_id,entry_id,revision_id,content_hash,entry_type,name,aliases,typed_fields,plain_text,canonical_payload,source_id,file_id,generation_id,document_id,lifecycle,edition,language)
         VALUES ($1,'qa-fixture',$2,$3,$4,'spell',$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,'active',$14,'en')`,
        [`63000000-0000-4000-8000-00000000000${suffix}`, `qa-spell-${suffix}`, `rev-${suffix.repeat(64)}`, `sha256:${suffix.repeat(64)}`, `QA Spell ${suffix}`,
          JSON.stringify([`QA Alias ${suffix}`]), JSON.stringify(typedFields), `First paragraph for ${title}. Printable second paragraph.`, JSON.stringify(canonicalPayload),
          id, fileId, generationId, documentId, edition],
      );
    }
    if (options.includeReview) await seedReviewFixture(client);
    await client.query("COMMIT");
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
  return tokens;
}

async function seedReviewFixture(client: Pool | PoolClient): Promise<void> {
  const sourceId = IDS.sources.open;
  const fileId = "30000000-0000-4000-8000-000000000001";
  await client.query(
    `INSERT INTO compendium_import_runs(id,source_id,file_id,generation_id,status,importer,importer_version,parser_version,prompt_version,model_version,input_sha256,checkpoint,lease_token,lease_expires_at,heartbeat_at,started_at)
     VALUES ($1,$2,$3,$4,'running','qa','1','1','none','none',$5,'occurrences','72000000-0000-4000-8000-000000000001',now()+interval '1 hour',now(),now())`,
    [IDS.browserImportRun, sourceId, fileId, "40000000-0000-4000-8000-000000000001", "a".repeat(64)],
  );
  const occurrenceId = "71000000-0000-4000-8000-000000000001";
  await client.query(
    `INSERT INTO compendium_import_occurrences(id,import_run_id,source_id,file_id,generation_id,chunk_id,occurrence_index,locator,fingerprint_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,0,'qa://spell',$7)`,
    [occurrenceId, IDS.browserImportRun, sourceId, fileId, "40000000-0000-4000-8000-000000000001", "62000000-0000-4000-8000-000000000001", "b".repeat(64)],
  );
  await client.query(
    `INSERT INTO compendium_import_candidates(import_run_id,source_id,file_id,generation_id,occurrence_id,candidate_order,candidate_key,entry_type,diff_status,content,content_sha256)
     VALUES ($1,$2,$3,$4,$5,0,'qa-review-spell','spell','new',$6::jsonb,$7)`,
    [IDS.browserImportRun, sourceId, fileId, "40000000-0000-4000-8000-000000000001", occurrenceId, JSON.stringify({ title: "QA review spell", body: "Review body" }), "c".repeat(64)],
  );
  await client.query(
    "UPDATE compendium_import_runs SET checkpoint='diffed',occurrence_count=1,candidate_count=1,new_count=1 WHERE id=$1",
    [IDS.browserImportRun],
  );
  await client.query(
    "UPDATE compendium_import_runs SET status='succeeded',checkpoint='completed',lease_token=NULL,lease_expires_at=NULL,finished_at=now() WHERE id=$1",
    [IDS.browserImportRun],
  );
}
