import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { collectNextDndSnapshots } from "../src/server/compendium/next-dnd/collector.ts";
import { NEXT_DND_CATEGORIES, type NextDndCategory } from "../src/server/compendium/next-dnd/parser.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    category: { type: "string", multiple: true },
    refresh: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    "allow-network": { type: "boolean", default: false },
    "delay-ms": { type: "string", default: "1000" },
    retries: { type: "string", default: "3" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage: npm run collect:next-dnd -- --output <directory> --allow-network [options]

Explicitly collects HTML snapshots from next.dnd.su. It does not publish content.

Options:
  --output <directory>   Snapshot store (required)
  --category <name>     Repeat to select categories; default: all supported
  --allow-network       Permit cache misses to contact next.dnd.su
  --refresh             Re-fetch URLs even when cached (requires --allow-network)
  --offline             Use retained cache only; never contact upstream
  --delay-ms <number>   Minimum delay between requests (default: 1000)
  --retries <number>    Retries after the initial request (default: 3)
  --help                 Show this help

Categories: ${Object.keys(NEXT_DND_CATEGORIES).join(", ")}`);
  process.exit(0);
}

if (!values.output) throw new Error("--output is required.");
if (values.offline && values["allow-network"]) throw new Error("--offline and --allow-network are mutually exclusive.");
if (values.refresh && !values["allow-network"]) throw new Error("--refresh requires --allow-network.");
if (!values.offline && !values["allow-network"]) {
  throw new Error("Pass --allow-network explicitly, or use --offline for cache-only collection.");
}

const categories = values.category?.map((category) => {
  if (!(category in NEXT_DND_CATEGORIES)) throw new Error(`Unknown category "${category}".`);
  return category as NextDndCategory;
});
const minimumDelayMs = parseInteger(values["delay-ms"], "--delay-ms");
const retries = parseInteger(values.retries, "--retries");
const result = await collectNextDndSnapshots({
  outputDirectory: resolve(values.output),
  allowNetwork: values["allow-network"],
  categories,
  refresh: values.refresh,
  offline: values.offline,
  minimumDelayMs,
  retries,
});

console.log(JSON.stringify({
  runDirectory: result.runDirectory,
  status: result.manifest.status,
  categories: result.manifest.categories.length,
  entries: result.manifest.categories.reduce((total, category) => total + category.entryCount, 0),
  details: result.manifest.categories.reduce((total, category) => total + category.details.length, 0),
  parserFailures: result.manifest.parserFailures.length,
  diagnostics: result.manifest.diagnostics.length,
}, null, 2));
if (result.manifest.status !== "complete") process.exitCode = 2;

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large.`);
  return parsed;
}
