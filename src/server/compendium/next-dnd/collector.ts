import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import {
  NEXT_DND_CATEGORIES,
  NEXT_DND_PARSER_VERSION,
  parseNextDndDetail,
  parseNextDndIndex,
  type NextDndCategory,
  type NextDndNormalizedDetail,
} from "./parser.ts";

export const NEXT_DND_ORIGIN = "https://next.dnd.su";
export const NEXT_DND_ROBOTS_USER_AGENT = "dnd.firegory.site-snapshot";

export type SnapshotResource = Readonly<{
  kind: "robots" | "index" | "detail";
  category: NextDndCategory | null;
  externalId: string | null;
  sourceUrl: string;
  finalUrl: string;
  redirectChain: readonly string[];
  fetchedAt: string;
  sha256: string;
  byteLength: number;
  parserVersion: string;
  blobPath: string;
}>;

export type SnapshotDetail = SnapshotResource & Readonly<{
  kind: "detail";
  category: NextDndCategory;
  externalId: string;
  normalized: NextDndNormalizedDetail;
  indexMetadata: Readonly<Record<string, unknown>>;
  indexSource: Readonly<{
    url: string;
    fingerprintSha256: string;
    rawBlobPath: string;
    fetchedAt: string;
    cardFingerprintSha256: string;
  }>;
}>;

export type ParserFailure = Readonly<{
  category: NextDndCategory | null;
  externalId: string | null;
  sourceUrl: string;
  stage: "robots" | "index" | "detail";
  phase: "fetch" | "policy" | "parse";
  message: string;
  snapshot: SnapshotResource | null;
}>;

export type CollectionDiagnostic = Readonly<{
  code: "stale-cache-fallback";
  sourceUrl: string;
  message: string;
  attempts: number;
}>;

type RobotsRule = Readonly<{ directive: "allow" | "disallow"; path: string }>;
type RobotsEvaluation = Readonly<{ sourceUrl: string; allowed: boolean }>;

export type NextDndSnapshotManifest = Readonly<{
  schemaVersion: 2;
  parserVersion: string;
  status: "complete" | "partial" | "failed";
  collectedAt: string;
  robots: Readonly<{
    userAgent: string;
    snapshot: SnapshotResource;
    rules: readonly RobotsRule[];
    evaluations: readonly RobotsEvaluation[];
  }> | null;
  categories: readonly Readonly<{
    requestedCategory: NextDndCategory;
    discoveredCategory: string | null;
    entryCount: number;
    index: SnapshotResource | null;
    details: readonly SnapshotDetail[];
  }>[];
  parserFailures: readonly ParserFailure[];
  diagnostics: readonly CollectionDiagnostic[];
}>;

export type CollectNextDndOptions = Readonly<{
  outputDirectory: string;
  allowNetwork: boolean;
  categories?: readonly NextDndCategory[];
  refresh?: boolean;
  offline?: boolean;
  minimumDelayMs?: number;
  retries?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  networkRequest?: NextDndNetworkRequest;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export type NextDndNetworkRequest = (
  url: URL,
  options: Readonly<{
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
    redirect: "manual";
    pinnedAddress: string;
    tlsServerName: string;
    hostHeader: string;
  }>,
) => Promise<Response>;

type CachedMetadata = Readonly<{
  sourceUrl: string;
  finalUrl: string;
  redirectChain: readonly string[];
  fetchedAt: string;
  sha256: string;
  byteLength: number;
  blobPath: string;
}>;
type CachedFetch = CachedMetadata & Readonly<{ cacheHit: boolean; bytes: Buffer }>;

type FetcherOptions = Readonly<{
  refresh: boolean;
  offline: boolean;
  minimumDelayMs: number;
  retries: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  networkRequest: NextDndNetworkRequest;
  resolveHostname: (hostname: string) => Promise<readonly string[]>;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  diagnostics: CollectionDiagnostic[];
}>;

export async function collectNextDndSnapshots(options: CollectNextDndOptions): Promise<Readonly<{ runDirectory: string; manifest: NextDndSnapshotManifest }>> {
  const categories = options.categories ?? Object.keys(NEXT_DND_CATEGORIES) as NextDndCategory[];
  if (categories.length === 0 || new Set(categories).size !== categories.length) throw new Error("At least one unique category is required.");
  for (const category of categories) if (!(category in NEXT_DND_CATEGORIES)) throw new Error(`Unsupported next.dnd.su category: ${category}`);
  const offline = options.offline ?? false;
  if (offline && options.allowNetwork) throw new Error("Offline collection requires allowNetwork=false.");
  if (!offline && options.allowNetwork !== true) throw new Error("Network consent is required by the collector API.");
  if (options.refresh && offline) throw new Error("refresh and offline modes are mutually exclusive.");

  const minimumDelayMs = options.minimumDelayMs ?? 1_000;
  const retries = options.retries ?? 3;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  requireInteger(minimumDelayMs, 1, 60_000, "minimumDelayMs");
  requireInteger(retries, 0, 10, "retries");
  requireInteger(requestTimeoutMs, 100, 120_000, "requestTimeoutMs");
  requireInteger(maxResponseBytes, 1_024, 50 * 1024 * 1024, "maxResponseBytes");
  requireInteger(maxRedirects, 0, 10, "maxRedirects");

  const diagnostics: CollectionDiagnostic[] = [];
  const now = options.now ?? (() => new Date());
  const fetcher = createCachedFetcher(options.outputDirectory, {
    refresh: options.refresh ?? false,
    offline,
    minimumDelayMs,
    retries,
    requestTimeoutMs,
    maxResponseBytes,
    maxRedirects,
    networkRequest: options.networkRequest ?? createPinnedHttpsNetworkRequest(),
    resolveHostname: options.resolveHostname ?? defaultResolveHostname,
    now,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    diagnostics,
  });
  const failures: ParserFailure[] = [];
  const collectedCategories: NextDndSnapshotManifest["categories"][number][] = [];
  const evaluations: RobotsEvaluation[] = [];
  let robots: NextDndSnapshotManifest["robots"] = null;

  const robotsUrl = new URL("/robots.txt", NEXT_DND_ORIGIN).href;
  let robotsFetch: CachedFetch | null = null;
  try {
    robotsFetch = await fetcher(robotsUrl, { forceNetwork: !offline, allowStaleFallback: false });
  } catch (error) {
    failures.push(failure(null, null, robotsUrl, "robots", "fetch", error, null));
  }
  if (robotsFetch) {
    const snapshot = resourceFromFetch(robotsFetch, "robots", null, null);
    try {
      const rules = parseRobots(decodeUtf8(robotsFetch.bytes, robotsUrl), NEXT_DND_ROBOTS_USER_AGENT);
      robots = { userAgent: NEXT_DND_ROBOTS_USER_AGENT, snapshot, rules, evaluations };
    } catch (error) {
      failures.push(failure(null, null, robotsUrl, "robots", "parse", error, snapshot));
    }
  }

  for (const category of categories) {
    const indexUrl = new URL(NEXT_DND_CATEGORIES[category].path, NEXT_DND_ORIGIN).href;
    if (!robots) {
      collectedCategories.push({ requestedCategory: category, discoveredCategory: null, entryCount: 0, index: null, details: [] });
      continue;
    }
    if (!evaluateRobots(indexUrl, robots.rules, evaluations)) {
      failures.push(failure(category, null, indexUrl, "index", "policy", new Error("robots.txt disallows this category index."), null));
      collectedCategories.push({ requestedCategory: category, discoveredCategory: null, entryCount: 0, index: null, details: [] });
      continue;
    }

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
      index = parseNextDndIndex(decodeUtf8(indexFetch.bytes, indexUrl), indexUrl, category);
    } catch (error) {
      failures.push(failure(category, null, indexUrl, "index", "parse", error, indexResource));
      collectedCategories.push({ requestedCategory: category, discoveredCategory: null, entryCount: 0, index: indexResource, details: [] });
      continue;
    }

    const details: SnapshotDetail[] = [];
    for (const entry of index.entries) {
      if (!evaluateRobots(entry.sourceUrl, robots.rules, evaluations)) {
        failures.push(failure(category, entry.externalId, entry.sourceUrl, "detail", "policy", new Error("robots.txt disallows this detail URL."), null));
        continue;
      }
      let detailFetch: CachedFetch;
      try {
        detailFetch = await fetcher(entry.sourceUrl);
      } catch (error) {
        failures.push(failure(category, entry.externalId, entry.sourceUrl, "detail", "fetch", error, null));
        continue;
      }
      const detailResource = resourceFromFetch(detailFetch, "detail", category, entry.externalId);
      try {
        const normalized = parseNextDndDetail(decodeUtf8(detailFetch.bytes, entry.sourceUrl), index.category, entry.externalId);
        details.push({
          ...detailResource,
          kind: "detail",
          category,
          externalId: entry.externalId,
          normalized,
          indexMetadata: entry.metadata,
          indexSource: {
            url: indexResource.sourceUrl,
            fingerprintSha256: indexResource.sha256,
            rawBlobPath: indexResource.blobPath,
            fetchedAt: indexResource.fetchedAt,
            cardFingerprintSha256: entry.cardFingerprintSha256,
          },
        });
      } catch (error) {
        failures.push(failure(category, entry.externalId, entry.sourceUrl, "detail", "parse", error, detailResource));
      }
    }
    collectedCategories.push({ requestedCategory: category, discoveredCategory: index.category, entryCount: index.entries.length, index: indexResource, details });
  }

  const complete = robots !== null && failures.length === 0 && collectedCategories.every((category) => category.index !== null && category.details.length === category.entryCount);
  const anySnapshot = robots !== null || collectedCategories.some((category) => category.index !== null || category.details.length > 0);
  const fetchedTimes = [robots?.snapshot.fetchedAt, ...collectedCategories.flatMap((category) => [category.index?.fetchedAt, ...category.details.map((detail) => detail.fetchedAt)])].filter((value): value is string => Boolean(value));
  const manifest: NextDndSnapshotManifest = {
    schemaVersion: 2,
    parserVersion: NEXT_DND_PARSER_VERSION,
    status: complete ? "complete" : anySnapshot ? "partial" : "failed",
    collectedAt: fetchedTimes.sort().at(-1) ?? now().toISOString(),
    robots,
    categories: collectedCategories,
    parserFailures: failures,
    diagnostics,
  };
  const identity = sha256(Buffer.from(JSON.stringify(manifest)));
  const runDirectory = join(options.outputDirectory, "runs", identity);
  await writeJson(join(runDirectory, "manifest.json"), manifest);
  await writeJson(join(runDirectory, "category-discovery.json"), manifest.categories.map(({ requestedCategory, discoveredCategory, entryCount, details }) => ({
    requestedCategory, discoveredCategory, entryCount, collectedDetailCount: details.length,
  })));
  await writeJson(join(runDirectory, "parser-failures.json"), failures);
  await writeJson(join(runDirectory, "collection-diagnostics.json"), diagnostics);
  return { runDirectory, manifest };
}

function createCachedFetcher(outputDirectory: string, options: FetcherOptions) {
  let lastRequestAt = 0;
  return async (sourceUrl: string, policy: Readonly<{ forceNetwork?: boolean; allowStaleFallback?: boolean }> = {}): Promise<CachedFetch> => {
    const initialUrl = new URL(sourceUrl);
    requireAllowedUrl(initialUrl);
    const cachePath = join(outputDirectory, "cache", `${sha256(Buffer.from(initialUrl.href))}.json`);
    const cached = await readJson<CachedMetadata>(cachePath);
    const loadCached = async (): Promise<CachedFetch | null> => {
      if (!cached || !(await exists(join(outputDirectory, cached.blobPath)))) return null;
      const bytes = await readFile(join(outputDirectory, cached.blobPath));
      if (bytes.byteLength !== cached.byteLength || sha256(bytes) !== cached.sha256) throw new Error(`Cached blob bytes or hash mismatch for ${initialUrl.href}.`);
      return { ...cached, cacheHit: true, bytes };
    };
    if (!options.refresh && !policy.forceNetwork) {
      const hit = await loadCached();
      if (hit) return hit;
    }
    if (options.offline) throw new Error(`No valid cached snapshot for ${initialUrl.href}; offline mode forbids a network request.`);

    let lastError: unknown;
    let attemptsMade = 0;
    for (let attempt = 0; attempt <= options.retries; attempt++) {
      attemptsMade++;
      try {
        const fetched = await requestWithRedirects(initialUrl, options, async () => {
          const wait = Math.max(0, options.minimumDelayMs - (Date.now() - lastRequestAt));
          if (wait > 0) await options.sleep(wait);
          lastRequestAt = Date.now();
        });
        const hash = sha256(fetched.bytes);
        const blobPath = join("blobs", `${hash}.html`);
        await writeImmutable(join(outputDirectory, blobPath), fetched.bytes, hash);
        const metadata: CachedMetadata = {
          sourceUrl: initialUrl.href,
          finalUrl: fetched.finalUrl,
          redirectChain: fetched.redirectChain,
          fetchedAt: options.now().toISOString(),
          sha256: hash,
          byteLength: fetched.bytes.byteLength,
          blobPath,
        };
        await writeJson(cachePath, metadata);
        return { ...metadata, cacheHit: false, bytes: fetched.bytes };
      } catch (error) {
        lastError = error;
        if (!(error instanceof RequestFailure) || !error.retryable || attempt === options.retries) break;
        await options.sleep(error.retryAfterMs ?? Math.min(30_000, 500 * 2 ** attempt));
      }
    }
    const fallback = policy.allowStaleFallback === false ? null : await loadCached();
    if (fallback) {
      options.diagnostics.push({
        code: "stale-cache-fallback",
        sourceUrl: initialUrl.href,
        message: lastError instanceof Error ? lastError.message : String(lastError),
        attempts: attemptsMade,
      });
      return fallback;
    }
    throw lastError;
  };
}

async function requestWithRedirects(initialUrl: URL, options: FetcherOptions, rateLimit: () => Promise<void>): Promise<Readonly<{ bytes: Buffer; finalUrl: string; redirectChain: readonly string[] }>> {
  let current = initialUrl;
  const redirectChain: string[] = [];
  for (let redirectCount = 0; ; redirectCount++) {
    const pinnedAddress = await validateNetworkTarget(current, options.resolveHostname);
    await rateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), options.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await options.networkRequest(current, {
          headers: { accept: "text/html,text/plain", "user-agent": `${NEXT_DND_ROBOTS_USER_AGENT}/2` },
          redirect: "manual",
          signal: controller.signal,
          pinnedAddress,
          tlsServerName: current.hostname,
          hostHeader: current.host,
        });
      } catch (error) {
        throw new RequestFailure(controller.signal.aborted ? "Request timed out." : `Network request failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new RequestFailure(`HTTP ${response.status} redirect has no Location header.`, false);
        if (redirectCount >= options.maxRedirects) throw new RequestFailure(`Redirect limit of ${options.maxRedirects} exceeded.`, false);
        let next: URL;
        try { next = new URL(location, current); }
        catch { throw new RequestFailure("Redirect Location is not a valid URL.", false); }
        requireAllowedUrl(next);
        redirectChain.push(next.href);
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        throw new RequestFailure(`HTTP ${response.status} ${response.statusText}`, retryable, retryable ? retryAfterMilliseconds(response.headers.get("retry-after"), options.now()) : null);
      }
      let bytes: Buffer;
      try {
        bytes = await readBoundedResponse(response, options.maxResponseBytes);
      } catch (error) {
        if (error instanceof RequestFailure) throw error;
        throw new RequestFailure(controller.signal.aborted ? "Request timed out while reading the response." : `Response stream failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      return { bytes, finalUrl: current.href, redirectChain };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new RequestFailure(`Response Content-Length exceeds ${maximumBytes} bytes.`, false);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RequestFailure(`Response body exceeds ${maximumBytes} bytes.`, false);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function validateNetworkTarget(url: URL, resolver: FetcherOptions["resolveHostname"]): Promise<string> {
  requireAllowedUrl(url);
  let addresses: readonly string[];
  try { addresses = await resolver(url.hostname); }
  catch (error) { throw new RequestFailure(`DNS lookup failed for ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`, true); }
  if (addresses.length === 0) throw new RequestFailure(`DNS lookup returned no addresses for ${url.hostname}.`, true);
  for (const address of addresses) {
    if (!isPublicAddress(address)) throw new RequestFailure(`DNS target ${address} is not a public IP address.`, false);
  }
  return addresses[0];
}

function requireAllowedUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "next.dnd.su" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new RequestFailure("Only credential-free HTTPS URLs on next.dnd.su are allowed.", false);
  }
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd")
      && !/^fe[89ab]/.test(normalized) && !normalized.startsWith("ff") && !normalized.startsWith("2001:db8");
  }
  return false;
}

function parseRobots(text: string, userAgent: string): readonly RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let group: { agents: string[]; rules: RobotsRule[] } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const field = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!group || group.rules.length > 0) { group = { agents: [], rules: [] }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group && (field === "allow" || field === "disallow")) {
      if (value) group.rules.push({ directive: field, path: value });
    }
  }
  const normalizedAgent = userAgent.toLowerCase();
  const matching = groups.map((candidate) => ({
    candidate,
    specificity: Math.max(-1, ...candidate.agents.map((agent) => agent === "*" ? 0 : normalizedAgent.startsWith(agent) ? agent.length : -1)),
  })).filter(({ specificity }) => specificity >= 0);
  const specificity = Math.max(-1, ...matching.map((candidate) => candidate.specificity));
  return matching.filter((candidate) => candidate.specificity === specificity).flatMap((candidate) => candidate.candidate.rules);
}

function evaluateRobots(sourceUrl: string, rules: readonly RobotsRule[], evidence: RobotsEvaluation[]): boolean {
  const url = new URL(sourceUrl);
  const target = `${url.pathname}${url.search}`;
  const matching = rules.filter((rule) => robotsRuleMatches(target, rule.path)).sort((left, right) => robotsRuleSpecificity(right.path) - robotsRuleSpecificity(left.path) || (left.directive === "allow" ? -1 : 1));
  const allowed = matching[0]?.directive !== "disallow";
  evidence.push({ sourceUrl: url.href, allowed });
  return allowed;
}

function robotsRuleMatches(target: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(target);
}

function robotsRuleSpecificity(pattern: string): number {
  return pattern.replace(/[\*$]/g, "").length;
}

function retryAfterMilliseconds(value: string | null, now: Date): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.min(120_000, Number(value.trim()) * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.min(120_000, Math.max(0, date - now.getTime()));
}

function resourceFromFetch(fetch: CachedFetch, kind: SnapshotResource["kind"], category: NextDndCategory | null, externalId: string | null): SnapshotResource {
  return {
    kind, category, externalId, sourceUrl: fetch.sourceUrl, finalUrl: fetch.finalUrl, redirectChain: fetch.redirectChain,
    fetchedAt: fetch.fetchedAt, sha256: fetch.sha256, byteLength: fetch.byteLength,
    parserVersion: NEXT_DND_PARSER_VERSION, blobPath: fetch.blobPath,
  };
}

function failure(
  category: NextDndCategory | null,
  externalId: string | null,
  sourceUrl: string,
  stage: ParserFailure["stage"],
  phase: ParserFailure["phase"],
  error: unknown,
  snapshot: SnapshotResource | null,
): ParserFailure {
  return { category, externalId, sourceUrl, stage, phase, message: error instanceof Error ? error.message : String(error), snapshot };
}

class RequestFailure extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, retryable: boolean, retryAfterMs: number | null = null) {
    super(message);
    this.name = "RequestFailure";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

type HttpsRequestFactory = (
  url: URL,
  options: RequestOptions,
  onResponse: (incoming: IncomingMessage) => void,
) => Readonly<{ on(event: "error", listener: (error: Error) => void): unknown; end(): void }>;

export function createPinnedHttpsNetworkRequest(
  requestFactory: HttpsRequestFactory = (url, options, onResponse) => httpsRequest(url, options, onResponse),
): NextDndNetworkRequest {
  return async (url, options) => new Promise((resolve, reject) => {
    const family = isIP(options.pinnedAddress);
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address: options.pinnedAddress, family }]);
      else callback(null, options.pinnedAddress, family);
    };
    const request = requestFactory(url, {
      method: "GET",
      agent: false,
      headers: { ...options.headers, host: options.hostHeader },
      servername: options.tlsServerName,
      signal: options.signal,
      lookup: pinnedLookup,
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const nullBody = status === 204 || status === 205 || status === 304;
        if (nullBody) incoming.destroy();
        resolve(new Response(nullBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status,
          statusText: incoming.statusMessage ?? "",
          headers,
        }));
      } catch (error) {
        incoming.destroy();
        reject(new Error(`Pinned HTTPS response construction failed for HTTP ${status}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    request.on("error", reject);
    request.end();
  });
}

async function writeImmutable(path: string, content: Buffer, expectedHash: string): Promise<void> {
  if (await exists(path)) {
    const existing = await readFile(path);
    if (existing.byteLength !== content.byteLength || sha256(existing) !== expectedHash) throw new Error(`Existing content-addressed blob failed byte/hash verification: ${path}`);
    return;
  }
  await atomicWrite(path, content);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, { flag: "wx" });
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

function decodeUtf8(value: Uint8Array, sourceUrl: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`Response from ${sourceUrl} is not valid UTF-8.`); }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
}
