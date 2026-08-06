import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  NEXT_DND_CATEGORIES,
  NEXT_DND_PARSER_VERSION,
  parseNextDndDetail,
  parseNextDndIndex,
  type NextDndCategory,
  type NextDndNormalizedDetail,
} from "./parser.ts";

export const NEXT_DND_ORIGIN = "https://next.dnd.su";

export type SnapshotResource = Readonly<{
  kind: "index" | "detail";
  category: NextDndCategory;
  externalId: string | null;
  sourceUrl: string;
  fetchedAt: string;
  sha256: string;
  parserVersion: string;
  blobPath: string;
}>;

export type SnapshotDetail = SnapshotResource & Readonly<{
  kind: "detail";
  externalId: string;
  normalized: NextDndNormalizedDetail;
  indexMetadata: Readonly<Record<string, unknown>>;
}>;

export type ParserFailure = Readonly<{
  category: NextDndCategory;
  externalId: string | null;
  sourceUrl: string;
  stage: "index" | "detail";
  phase: "fetch" | "parse";
  message: string;
  snapshot: SnapshotResource | null;
}>;

export type NextDndSnapshotManifest = Readonly<{
  schemaVersion: 1;
  parserVersion: string;
  collectedAt: string;
  categories: readonly Readonly<{
    requestedCategory: NextDndCategory;
    discoveredCategory: string | null;
    entryCount: number;
    index: SnapshotResource | null;
    details: readonly SnapshotDetail[];
  }>[];
  parserFailures: readonly ParserFailure[];
}>;

export type CollectNextDndOptions = Readonly<{
  outputDirectory: string;
  categories?: readonly NextDndCategory[];
  refresh?: boolean;
  offline?: boolean;
  minimumDelayMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

type CachedFetch = Readonly<{ sourceUrl: string; fetchedAt: string; sha256: string; blobPath: string; cacheHit: boolean; html: string }>;

export async function collectNextDndSnapshots(options: CollectNextDndOptions): Promise<Readonly<{ runDirectory: string; manifest: NextDndSnapshotManifest }>> {
  const categories = options.categories ?? Object.keys(NEXT_DND_CATEGORIES) as NextDndCategory[];
  if (categories.length === 0 || new Set(categories).size !== categories.length) throw new Error("At least one unique category is required.");
  for (const category of categories) if (!(category in NEXT_DND_CATEGORIES)) throw new Error(`Unsupported next.dnd.su category: ${category}`);
  const minimumDelayMs = options.minimumDelayMs ?? 1_000;
  const retries = options.retries ?? 3;
  if (options.refresh && options.offline) throw new Error("refresh and offline modes are mutually exclusive.");
  if (!Number.isSafeInteger(minimumDelayMs) || minimumDelayMs < 0) throw new Error("minimumDelayMs must be a nonnegative integer.");
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw new Error("retries must be between 0 and 10.");

  const fetcher = createCachedFetcher(options.outputDirectory, {
    refresh: options.refresh ?? false,
    offline: options.offline ?? false,
    minimumDelayMs,
    retries,
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  });
  const failures: ParserFailure[] = [];
  const collectedCategories: NextDndSnapshotManifest["categories"][number][] = [];

  for (const category of categories) {
    const indexUrl = new URL(NEXT_DND_CATEGORIES[category].path, NEXT_DND_ORIGIN).href;
    let indexFetch: CachedFetch;
    try {
      indexFetch = await fetcher(indexUrl);
    } catch (error) {
      failures.push(failure(category, null, indexUrl, "index", "fetch", error, null));
      collectedCategories.push({ requestedCategory: category, discoveredCategory: null, entryCount: 0, index: null, details: [] });
      continue;
    }
    const indexResource = resourceFromFetch(indexFetch, "index", category, null);
    let index;
    try {
      index = parseNextDndIndex(indexFetch.html, indexUrl, category);
    } catch (error) {
      failures.push(failure(category, null, indexUrl, "index", "parse", error, indexResource));
      collectedCategories.push({ requestedCategory: category, discoveredCategory: null, entryCount: 0, index: indexResource, details: [] });
      continue;
    }

    const details: SnapshotDetail[] = [];
    for (const entry of index.entries) {
      let detailFetch: CachedFetch;
      try {
        detailFetch = await fetcher(entry.sourceUrl);
      } catch (error) {
        failures.push(failure(category, entry.externalId, entry.sourceUrl, "detail", "fetch", error, null));
        continue;
      }
      const detailResource = resourceFromFetch(detailFetch, "detail", category, entry.externalId);
      try {
        const normalized = parseNextDndDetail(detailFetch.html, category, entry.externalId);
        details.push({
          ...detailResource,
          kind: "detail",
          externalId: entry.externalId,
          normalized,
          indexMetadata: entry.metadata,
        });
      } catch (error) {
        failures.push(failure(category, entry.externalId, entry.sourceUrl, "detail", "parse", error, detailResource));
      }
    }
    collectedCategories.push({ requestedCategory: category, discoveredCategory: index.category, entryCount: index.entries.length, index: indexResource, details });
  }

  const fetchedTimes = collectedCategories.flatMap((category) => [category.index?.fetchedAt, ...category.details.map((detail) => detail.fetchedAt)]).filter((value): value is string => Boolean(value));
  const manifest: NextDndSnapshotManifest = {
    schemaVersion: 1,
    parserVersion: NEXT_DND_PARSER_VERSION,
    collectedAt: fetchedTimes.sort().at(-1) ?? (options.now ?? (() => new Date()))().toISOString(),
    categories: collectedCategories,
    parserFailures: failures,
  };
  const identity = sha256(JSON.stringify(manifest));
  const runDirectory = join(options.outputDirectory, "runs", identity);
  await writeJson(join(runDirectory, "manifest.json"), manifest);
  await writeJson(join(runDirectory, "category-discovery.json"), manifest.categories.map(({ requestedCategory, discoveredCategory, entryCount, details }) => ({
    requestedCategory, discoveredCategory, entryCount, collectedDetailCount: details.length,
  })));
  await writeJson(join(runDirectory, "parser-failures.json"), failures);
  return { runDirectory, manifest };
}

function createCachedFetcher(outputDirectory: string, options: Required<Pick<CollectNextDndOptions, "refresh" | "offline" | "minimumDelayMs" | "retries" | "fetch" | "now" | "sleep">>) {
  let lastRequestAt = 0;
  return async (sourceUrl: string): Promise<CachedFetch> => {
    const url = new URL(sourceUrl);
    if (url.origin !== NEXT_DND_ORIGIN) throw new Error(`Refusing to fetch outside ${NEXT_DND_ORIGIN}.`);
    const cachePath = join(outputDirectory, "cache", `${sha256(url.href)}.json`);
    const cached = await readJson<Omit<CachedFetch, "html" | "cacheHit">>(cachePath);
    const loadCached = async (): Promise<CachedFetch | null> => {
      if (!cached || !(await exists(join(outputDirectory, cached.blobPath)))) return null;
      const html = await readFile(join(outputDirectory, cached.blobPath), "utf8");
      if (sha256(html) !== cached.sha256) throw new Error(`Cached blob hash mismatch for ${url.href}.`);
      return { ...cached, cacheHit: true, html };
    };
    if (!options.refresh) {
      const hit = await loadCached();
      if (hit) return hit;
    }
    if (options.offline) throw new Error(`No cached snapshot for ${url.href}; offline mode forbids a network request.`);

    let lastError: unknown;
    for (let attempt = 0; attempt <= options.retries; attempt++) {
      const wait = Math.max(0, options.minimumDelayMs - (Date.now() - lastRequestAt));
      if (wait) await options.sleep(wait);
      lastRequestAt = Date.now();
      try {
        const response = await options.fetch(url, { headers: { accept: "text/html", "user-agent": "dnd.firegory.site snapshot collector/1" }, redirect: "follow" });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (response.url && new URL(response.url).origin !== NEXT_DND_ORIGIN) throw new Error(`Refusing redirect outside ${NEXT_DND_ORIGIN}.`);
        const html = await response.text();
        const hash = sha256(html);
        const blobPath = join("blobs", `${hash}.html`);
        await writeImmutable(join(outputDirectory, blobPath), html);
        const metadata = { sourceUrl: url.href, fetchedAt: options.now().toISOString(), sha256: hash, blobPath };
        await writeJson(cachePath, metadata);
        return { ...metadata, cacheHit: false, html };
      } catch (error) {
        lastError = error;
        if (attempt < options.retries) await options.sleep(Math.min(30_000, 500 * 2 ** attempt));
      }
    }
    const fallback = await loadCached();
    if (fallback) return fallback;
    throw lastError;
  };
}

function resourceFromFetch(fetch: CachedFetch, kind: SnapshotResource["kind"], category: NextDndCategory, externalId: string | null): SnapshotResource {
  return { kind, category, externalId, sourceUrl: fetch.sourceUrl, fetchedAt: fetch.fetchedAt, sha256: fetch.sha256, parserVersion: NEXT_DND_PARSER_VERSION, blobPath: fetch.blobPath };
}

function failure(
  category: NextDndCategory,
  externalId: string | null,
  sourceUrl: string,
  stage: ParserFailure["stage"],
  phase: ParserFailure["phase"],
  error: unknown,
  snapshot: SnapshotResource | null,
): ParserFailure {
  return { category, externalId, sourceUrl, stage, phase, message: error instanceof Error ? error.message : String(error), snapshot };
}

async function writeImmutable(path: string, content: string): Promise<void> {
  if (await exists(path)) return;
  await atomicWrite(path, content);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
