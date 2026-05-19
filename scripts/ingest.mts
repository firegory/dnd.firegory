/**
 * CLI command for batch/debug PDF ingestion.
 *
 * Usage:
 *   node --experimental-strip-types scripts/ingest.mts \
 *     --pdf path/to/book.pdf \
 *     --title "Player's Handbook" \
 *     --category core_rules \
 *     --edition 5e \
 *     --language en \
 *     --access open
 *
 * Or via npm:
 *   npm run ingest -- --pdf path/to/book.pdf --title "..." ...
 */

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

import { startIngestion, getIngestionStatus } from "../src/server/ingestion/lifecycle.ts";
import {
  validateIngestionArgs,
} from "../src/cli/validate-args.ts";

// ── Argument parsing ────────────────────────────────────────────────

function parseCliArgs(): ReturnType<typeof validateIngestionArgs> {
  const { values } = parseArgs({
    options: {
      pdf: { type: "string" },
      title: { type: "string" },
      category: { type: "string" },
      edition: { type: "string" },
      language: { type: "string" },
      access: { type: "string" },
      "owner-user-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: npm run ingest -- \\
  --pdf <path-to-pdf> \\
  --title <source title> \\
  --category <core_rules|official_supplement|homebrew> \\
  --edition <5e|5.5e> \\
  --language <en|ru> \\
  --access <open|premium|personal> \\
  [--owner-user-id <uuid>]

Required environment variables:
  DATABASE_URL   — Postgres connection string
  REDIS_URL      — Redis connection string
  STORAGE_ROOT   — Root directory for file storage

Options:
  --pdf            Path to a local PDF file (required)
  --title          Source title for the ingestion record (required)
  --category       Content category: core_rules, official_supplement, homebrew (required)
  --edition        D&D edition: 5e or 5.5e (required)
  --language       Language code: en or ru (required)
  --access         Access tier: open, premium, or personal (required)
  --owner-user-id  Owner user ID for personal content (optional)
  --help           Show this help message`);
    process.exit(0);
  }

  try {
    return validateIngestionArgs({
      pdf: values.pdf as string | undefined,
      title: values.title as string | undefined,
      category: values.category as string | undefined,
      edition: values.edition as string | undefined,
      language: values.language as string | undefined,
      access: values.access as string | undefined,
      ownerUserId: values["owner-user-id"] as string | undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    console.error("Run with --help for usage information.");
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs();

  // Read the PDF file
  let pdfData: Buffer;
  try {
    pdfData = await readFile(args.pdf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: cannot read PDF file "${args.pdf}": ${message}`);
    process.exit(1);
  }

  if (pdfData.byteLength === 0) {
    console.error(`Error: PDF file "${args.pdf}" is empty.`);
    process.exit(1);
  }

  console.log(`Ingesting: ${args.pdf}`);
  console.log(`  Title:    ${args.title}`);
  console.log(`  Category: ${args.category}`);
  console.log(`  Edition:  ${args.edition}`);
  console.log(`  Language: ${args.language}`);
  console.log(`  Access:   ${args.access}`);
  if (args.ownerUserId) {
    console.log(`  Owner:    ${args.ownerUserId}`);
  }
  console.log(`  Size:     ${pdfData.byteLength} bytes`);

  const originalFilename = basename(args.pdf);

  const result = await startIngestion({
    title: args.title,
    category: args.category,
    edition: args.edition,
    language: args.language,
    accessTier: args.access,
    ownerUserId: args.ownerUserId,
    originalFilename,
    pdfData,
    kind: "cli",
  });

  console.log("\nIngestion started:");
  console.log(`  Source ID: ${result.sourceId}`);
  console.log(`  File ID:   ${result.fileId}`);
  console.log(`  Job ID:    ${result.jobId}`);
  console.log(`  Queue ID:  ${result.queueId}`);

  // Attempt to fetch the current job status for confirmation
  const job = await getIngestionStatus(result.jobId);
  if (job) {
    console.log(`  Status:    ${job.status}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exitCode = 1;
});
