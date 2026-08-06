import process from "node:process";
import { parseArgs } from "node:util";

import { synchronizeContentIndex, type SyncMode } from "../src/server/content-index/sync.ts";
import { backfillContentIndexEmbeddings } from "../src/server/content-index/embeddings.ts";

const usage = `Usage:
  npm run content-index -- validate [--data-root <path>]
  npm run content-index -- clean [--dry-run] [--data-root <path>]
  npm run content-index -- incremental [--dry-run] [--data-root <path>]
  npm run content-index -- backfill-embeddings [--batch-size <1-100>]

All modes resolve activation deltas and validate canonical schemas and hashes
before querying or mutating PostgreSQL. validate never connects to PostgreSQL.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      "data-root": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "batch-size": { type: "string", default: "20" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !["clean", "incremental", "validate", "backfill-embeddings"].includes(command ?? "")) {
    throw new Error(`${usage}\n\nExpected exactly one documented command.`);
  }
  if (command === "validate" && values["dry-run"]) throw new Error("validate is already read-only; --dry-run is not accepted.");
  if (command === "backfill-embeddings") {
    if (values["dry-run"] || values["data-root"]) throw new Error("backfill-embeddings accepts only --batch-size.");
    const updated = await backfillContentIndexEmbeddings(Number(values["batch-size"]));
    console.log(JSON.stringify({ mode: command, updated }, null, 2));
    return;
  }

  const result = await synchronizeContentIndex({
    mode: command as SyncMode | "validate",
    dryRun: values["dry-run"],
    dataRoot: values["data-root"],
  });
  console.log(JSON.stringify({
    ...result,
    counts: {
      additions: result.plan.additions.length,
      updates: result.plan.updates.length,
      removals: result.plan.removals.length,
    },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
