import process from "node:process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { generateCorpusExport, validatePublishedCorpusExport } from "../src/server/corpus-export/export.ts";
import { getDataRoot } from "../src/server/content-storage/repository.ts";

const usage = `Usage:
  npm run corpus-export -- generate [--data-root <path>] [--from <export-id>] [--no-latest]
  npm run corpus-export -- validate [--data-root <path>] [--export <export-id>]

Generation resolves and validates canonical NFS revisions without PostgreSQL. The
default comparison boundary is exports/latest.json. Validation defaults to latest.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      "data-root": { type: "string" },
      from: { type: "string" },
      export: { type: "string" },
      "no-latest": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["generate", "validate"].includes(command ?? "")) throw new Error(`${usage}\n\nExpected one documented command.`);
  if (command === "generate") {
    if (values.export) throw new Error("generate does not accept --export.");
    const output = await generateCorpusExport({
      dataRoot: values["data-root"],
      fromExportId: values.from,
      publishLatest: !values["no-latest"],
    });
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (values.from || values["no-latest"]) throw new Error("validate does not accept --from or --no-latest.");
  const dataRoot = resolve(values["data-root"] ?? getDataRoot());
  const validated = await validatePublishedCorpusExport(dataRoot, values.export);
  console.log(JSON.stringify({ exportId: validated.manifest.exportId, catalogHash: validated.manifest.catalogHash, valid: true }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
