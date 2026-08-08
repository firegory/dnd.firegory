import process from "node:process";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { getPool } from "../src/server/db/client.ts";
import { inspectPreparedSeed, loadPreparedSeed, type SeedSlotResult } from "../src/server/corpus-seed/executor.ts";
import { captureSeedDescriptors, prepareCapturedSeed, sha256, writeManifestAtomic } from "../src/server/corpus-seed/model.ts";
import { seedCommandIncomplete } from "../src/server/corpus-seed/status.ts";

const usage = `Usage:
  npm run corpus-seed -- validate --inputs <operator-inputs.json> --manifest <run-manifest.json>
  npm run corpus-seed -- load --inputs <operator-inputs.json> --manifest <run-manifest.json>
  npm run corpus-seed -- status --inputs <operator-inputs.json> --manifest <run-manifest.json>

validate is filesystem-only. load and status require DATABASE_URL and applied migrations.
load creates review candidates only; it never reviews or publishes them.`;

const manifestArgument = argumentValue("--manifest");
const approvedTypes = ["background", "class", "creature", "equipment", "feat", "feature", "glossary", "item", "species", "spell"].sort();
const startedAt = new Date().toISOString();
let manifestPath = manifestArgument ? resolve(manifestArgument) : null;
let command = process.argv[2] ?? null;
const planPath = resolve("config/corpus-seed-2024.json");
let inputsPath: string | null = null;
let planDigest: string | null = null;
let planFileDigest: string | null = null;
let planId: string | null = null;
let inputDigest: string | null = null;
let inputDescriptorDigest: string | null = null;
let results: readonly SeedSlotResult[] = [];
let plannedContentTypes: readonly string[] = approvedTypes;
let databaseUsed = false;

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputs: { type: "string" },
      manifest: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) { console.log(usage); process.exit(0); }
  if (positionals.length !== 1 || !["validate", "load", "status"].includes(positionals[0])) throw new Error(`${usage}\n\nExpected exactly one documented command.`);
  command = positionals[0];
  if (!values.inputs || !values.manifest) throw new Error("--inputs and --manifest are required.");
  inputsPath = resolve(values.inputs);
  manifestPath = resolve(values.manifest);
  const captured = await captureSeedDescriptors(planPath, inputsPath);
  const prepared = await prepareCapturedSeed(captured);
  planFileDigest = sha256(captured.planBytes);
  inputDescriptorDigest = sha256(captured.inputBytes);
  if (prepared.plan.planId !== "approved-2024-corpus-v1"
    || JSON.stringify(prepared.plan.slots.map(({ contentType }) => contentType).sort()) !== JSON.stringify(approvedTypes)) {
    throw new Error("The configured seed plan is not the approved complete 2024 plan.");
  }
  planId = prepared.plan.planId;
  planDigest = prepared.planDigest;
  inputDigest = prepared.inputDigest;
  plannedContentTypes = prepared.plan.slots.map(({ contentType }) => contentType);
  results = prepared.slots.map((slot) => ({
    slotId: slot.planSlot.id,
    contentType: slot.planSlot.contentType,
    sourceId: null,
    importRunId: null,
    operation: "absent" as const,
    counts: { discovered: slot.discovered, imported: 0, reviewed: 0, published: 0, indexed: 0, failures: 0 },
    failures: [],
    provenance: {
      canonicalSourceId: slot.input.source.canonicalSourceId,
      originUrl: slot.input.source.originUrl,
      originId: slot.input.source.originId,
      attribution: slot.input.source.attribution,
      license: slot.input.source.license,
      evidenceReference: slot.input.source.licenseApproval.evidenceUri,
      evidenceSha256: slot.input.source.licenseApproval.evidenceSha256,
    },
  }));
  if (command === "load") {
    if (process.env.CORPUS_SEED_WRITER_ROLE !== "worker") throw new Error("load requires CORPUS_SEED_WRITER_ROLE=worker and must run as the single canonical writer.");
    if (!process.env.DND_DATA_ROOT) throw new Error("load requires worker-owned DND_DATA_ROOT.");
    databaseUsed = true;
    results = await loadPreparedSeed(prepared, { dataRoot: process.env.DND_DATA_ROOT });
  }
  else if (command === "status") {
    if (!process.env.DND_DATA_ROOT) throw new Error("status requires DND_DATA_ROOT to verify installed canonical evidence.");
    databaseUsed = true; results = await inspectPreparedSeed(prepared, getPool(), process.env.DND_DATA_ROOT);
  }
  const incomplete = seedCommandIncomplete(command, results);
  await emitManifest(incomplete ? "failed" : "succeeded", incomplete ? "One or more required seed slots are absent, pending, failed, partial, or missing evidence." : null);
  console.log(JSON.stringify({ status: incomplete ? "failed" : "succeeded", manifest: manifestPath, planDigest, inputDigest, slots: results.length }, null, 2));
  if (incomplete) process.exitCode = 2;
} catch (error) {
  const message = safeError(error);
  if (manifestPath) {
    await emitManifest("failed", message).catch((manifestError) => console.error(`Unable to write seed run manifest: ${safeError(manifestError)}`));
  }
  console.error(message);
  process.exitCode = 1;
} finally {
  if (databaseUsed) await getPool().end().catch(() => undefined);
}

async function emitManifest(status: "succeeded" | "failed", failure: string | null): Promise<void> {
  if (!manifestPath) throw new Error("A manifest path is required before execution.");
  const finishedAt = new Date().toISOString();
  await writeManifestAtomic(manifestPath, {
    schemaVersion: 1,
    kind: "corpusSeedRun",
    command,
    status,
    startedAt,
    finishedAt,
    plan: { id: planId, file: basename(planPath), fileDigestSha256: planFileDigest, resolvedDigestSha256: planDigest },
    input: { descriptor: inputsPath ? basename(inputsPath) : null, descriptorDigestSha256: inputDescriptorDigest, resolvedDigestSha256: inputDigest },
    counts: Object.fromEntries(results.length > 0
      ? results.map(({ contentType, counts }) => [contentType, counts])
      : plannedContentTypes.map((contentType) => [contentType, { discovered: 0, imported: 0, reviewed: 0, published: 0, indexed: 0, failures: status === "failed" ? 1 : 0 }])),
    sources: results.map(({ slotId, sourceId, importRunId, operation, provenance }) => ({ slotId, sourceId, importRunId, operation, provenance })),
    failures: [...results.flatMap(({ failures }) => failures), ...(failure ? [failure] : [])],
    evidenceGate: { structuralDeclarationOnly: true, independentlyVerifiedExternalApprovalArtifactRequired: true },
    safety: { autoPublished: false, pathsRedacted: true, secretsRedacted: true },
  });
}

function argumentValue(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[REDACTED_DATABASE_URL]").replace(/(bearer\s+)[^\s]+/giu, "$1[REDACTED]").replace(/(^|[\s"'])\/(?:[^\s"']+)/gu, "$1[REDACTED_PATH]").slice(0, 2000); }
