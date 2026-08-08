import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { Client, Pool } from "pg";

import { assertQaDatabase, databaseUrlForDatabase, IDS, requireDatabaseUrl, runProductionMigrations, seedAccessFixture } from "../qa/postgres.mts";

export default async function globalSetup(): Promise<void> {
  const databaseName = process.env.QA_BROWSER_DATABASE?.trim() || "qa_browser";
  assertQaDatabase(databaseName);
  const base = requireDatabaseUrl();
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
  const url = databaseUrlForDatabase(base, databaseName);
  let tokens: Record<string, string>;
  try {
    await runProductionMigrations(url);
    const storageRoot = "/tmp/dnd-firegory-qa-storage";
    await rm(storageRoot, { recursive: true, force: true });
    const pdf = minimalPdf();
    for (const sourceId of Object.values(IDS.sources)) {
      const suffix = sourceId.at(-1)!;
      const fileId = `30000000-0000-4000-8000-00000000000${suffix}`;
      const directory = `${storageRoot}/originals/${sourceId}`;
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/${fileId}.pdf`, pdf);
    }
    const pool = new Pool({ connectionString: url });
    try {
      tokens = await seedAccessFixture(pool, {
        includeReview: true,
        storageRoot,
        fileChecksumSha256: createHash("sha256").update(pdf).digest("hex"),
      });
    } finally {
      await pool.end();
    }
  } catch (error) {
    const cleanup = new Client({ connectionString: base });
    await cleanup.connect();
    try {
      await cleanup.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    } finally {
      await cleanup.end();
    }
    throw error;
  }

  const authRoot = "/tmp/dnd-firegory-qa-auth";
  await rm(authRoot, { recursive: true, force: true });
  await mkdir(authRoot, { recursive: true, mode: 0o700 });
  for (const role of ["user", "empty", "premium", "owner", "admin"] as const) {
    const tokenKey = role === "user" ? "regular" : role;
    await writeFile(`${authRoot}/${role}.json`, JSON.stringify({
      cookies: [{ name: "dnd_firegory_session", value: tokens[tokenKey], domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [{ origin: "http://127.0.0.1:3100", localStorage: [{ name: "dnd.firegory.uiLanguage", value: "en" }] }],
    }), { mode: 0o600 });
  }
}

function minimalPdf(): Buffer {
  const stream = "BT /F1 18 Tf 40 160 Td (QA citation) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
