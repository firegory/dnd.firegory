import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { NEXT_DND_CATEGORIES, NEXT_DND_PARSER_VERSION, parseNextDndDetail, parseNextDndIndex, type NextDndCategory } from "../compendium/next-dnd/parser.ts";
import { nextDndImportBatch } from "../compendium/next-dnd/import-adapter.ts";
import type { NextDndSnapshotManifest, SnapshotDetail } from "../compendium/next-dnd/collector.ts";
import { featureCandidates } from "../compendium/next-dnd/hierarchy-import.ts";

export const SEED_SCHEMA_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const SLOT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const CONTENT_TYPES: ReadonlySet<string> = new Set([...Object.values(NEXT_DND_CATEGORIES).map(({ entryType }) => entryType), "feature"]);
const LICENSE_BASES = new Set(["cc-by-4.0", "cc0-1.0", "operator-permission"]);

export type SeedPlanSlot = Readonly<{ id: string; contentType: string; snapshotCategory: NextDndCategory; inputSlotId: string; dependsOn: readonly string[]; required: boolean }>;
export type SeedPlan = Readonly<{
  schemaVersion: 1;
  planId: string;
  edition: "5.5e";
  description: string;
  slots: readonly SeedPlanSlot[];
  sourceRequirements: Readonly<{
    format: "next-dnd-snapshot-v2"; operatorSupplied: true; licenseApprovalRequired: true; attributionRequired: true; provenanceRequired: true;
    allowedLicenseBases: readonly string[]; approvedBy: readonly string[]; evidenceSchemes: readonly string[];
  }>;
  exclusions: readonly string[];
}>;
export type SeedInputSlot = Readonly<{
  slotId: string;
  snapshotRoot: string;
  manifestPath: string;
  source: Readonly<{
    canonicalSourceId: string;
    title: string;
    language: "en" | "ru";
    category: "core_rules" | "official_supplement";
    accessTier: "open" | "premium";
    publicationCode: string;
    publisher: string;
    revision: string;
    canonicalBookId: string;
    originUrl: string;
    originId: string;
    attribution: string;
    license: string;
    licenseApproval: Readonly<{ basis: string; approvedBy: string; approvedAt: string; evidenceUri: string; evidenceSha256: string }>;
  }>;
}>;
export type SeedInputs = Readonly<{ schemaVersion: 1; planId: string; slots: readonly SeedInputSlot[] }>;
export type PreparedSeedSlot = Readonly<{
  planSlot: SeedPlanSlot;
  input: SeedInputSlot;
  manifest: NextDndSnapshotManifest;
  manifestBytes: Buffer;
  manifestDigest: string;
  manifestByteLength: number;
  inputManifestDigest: string;
  evidenceFiles: readonly Readonly<{ sha256: string; byteLength: number; mediaType: "text/html"; bytes: Buffer; canonicalPath: string }>[];
  inputDigest: string;
  discovered: number;
}>;
export type PreparedSeed = Readonly<{ plan: SeedPlan; inputs: SeedInputs; planDigest: string; inputDigest: string; slots: readonly PreparedSeedSlot[] }>;

export async function prepareSeed(planPath: string, inputsPath: string, now = new Date()): Promise<PreparedSeed> {
  const planBytes = await readStableFile(resolve(planPath), dirname(resolve(planPath)), "seed plan");
  const inputBytes = await readStableFile(resolve(inputsPath), dirname(resolve(inputsPath)), "seed inputs");
  const plan = validatePlan(parseJson(planBytes, "seed plan"));
  const inputs = validateInputs(parseJson(inputBytes, "seed inputs"), plan, now);
  const inputsDirectory = dirname(resolve(inputsPath));
  const slots: PreparedSeedSlot[] = [];
  for (const planSlot of plan.slots) {
    const input = inputs.slots.find(({ slotId }) => slotId === planSlot.inputSlotId)!;
    const manifestPath = resolve(inputsDirectory, input.manifestPath);
    const snapshotRoot = resolve(inputsDirectory, input.snapshotRoot);
    const manifestRelative = relative(snapshotRoot, manifestPath);
    if (!manifestRelative || manifestRelative.startsWith("..") || isAbsolute(manifestRelative)) throw new Error(`Slot ${planSlot.id} manifest must remain inside snapshotRoot.`);
    await assertNoSymlinkComponents(inputsDirectory, snapshotRoot, `slot ${planSlot.id} snapshotRoot`);
    const snapshotRootReal = await realpath(snapshotRoot);
    if (snapshotRootReal !== snapshotRoot) throw new Error(`Slot ${planSlot.id} snapshotRoot must not resolve through aliases.`);
    const inputManifestBytes = await readStableFile(manifestPath, snapshotRoot, `slot ${planSlot.id} manifest`);
    const inputManifest = validateSnapshot(parseJson(inputManifestBytes, `slot ${planSlot.id} manifest`), planSlot);
    if (input.source.originUrl !== inputManifest.categories[0].index!.sourceUrl) throw new Error(`Input slot ${planSlot.id} provenance origin does not match its snapshot index.`);
    const evidenceFiles = await validateSnapshotBlobs(inputManifest, snapshotRoot, input.source.canonicalSourceId);
    const manifest = durableManifest(inputManifest, input.source.canonicalSourceId);
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
    nextDndImportBatch(manifest);
    const discovered = planSlot.contentType === "feature" ? manifest.categories[0].details.reduce((count, detail) => count + featureCandidates(detail).length, 0) : manifest.categories[0].entryCount;
    if (discovered < 1) throw new Error(`Required slot ${planSlot.id} discovered no publishable candidates.`);
    slots.push({
      planSlot,
      input,
      manifest,
      manifestBytes,
      manifestDigest: sha256(manifestBytes),
      manifestByteLength: manifestBytes.byteLength,
      inputManifestDigest: sha256(inputManifestBytes),
      evidenceFiles,
      inputDigest: sha256(canonicalJson({ input, manifest: JSON.parse(inputManifestBytes.toString("utf8")), contentType: planSlot.contentType })),
      discovered,
    });
  }
  return {
    plan,
    inputs,
    planDigest: sha256(canonicalJson(plan)),
    inputDigest: sha256(canonicalJson(slots.map(({ planSlot, inputDigest }) => ({ slotId: planSlot.id, inputDigest })))),
    slots,
  };
}

export function validatePlan(value: unknown): SeedPlan {
  const plan = record(value, "Seed plan must be an object.");
  exactKeys(plan, ["schemaVersion", "planId", "edition", "description", "slots", "sourceRequirements", "exclusions"], "seed plan");
  if (plan.schemaVersion !== 1 || plan.edition !== "5.5e") throw new Error("Only seed plan schema 1 for edition 5.5e is approved.");
  text(plan.planId, "planId"); text(plan.description, "description");
  if (!Array.isArray(plan.slots) || plan.slots.length === 0) throw new Error("Seed plan slots must be a non-empty array.");
  const slots = plan.slots.map((value, index) => {
    const slot = record(value, `Seed plan slot ${index} must be an object.`);
    exactKeys(slot, ["id", "contentType", "snapshotCategory", "inputSlotId", "dependsOn", "required"], `seed plan slot ${index}`);
    if (typeof slot.id !== "string" || !SLOT_ID.test(slot.id)) throw new Error(`Seed plan slot ${index} has an invalid id.`);
    if (typeof slot.snapshotCategory !== "string" || !(slot.snapshotCategory in NEXT_DND_CATEGORIES)) throw new Error(`Seed plan slot ${slot.id} has an unsupported snapshot category.`);
    if (typeof slot.contentType !== "string" || !CONTENT_TYPES.has(slot.contentType)) throw new Error(`Seed plan slot ${slot.id} has an unsupported content type.`);
    if (typeof slot.inputSlotId !== "string" || !SLOT_ID.test(slot.inputSlotId)) throw new Error(`Seed plan slot ${slot.id} has an invalid inputSlotId.`);
    if (!Array.isArray(slot.dependsOn) || slot.dependsOn.some((item) => typeof item !== "string" || !SLOT_ID.test(item))) throw new Error(`Seed plan slot ${slot.id} has invalid dependencies.`);
    if (slot.contentType === "feature" ? slot.snapshotCategory !== "class" : NEXT_DND_CATEGORIES[slot.snapshotCategory as NextDndCategory].entryType !== slot.contentType) throw new Error(`Seed plan slot ${slot.id} category/type mapping is not approved.`);
    if (slot.required !== true) throw new Error(`Seed plan slot ${slot.id} must be required.`);
    return slot as unknown as SeedPlanSlot;
  });
  if (new Set(slots.map(({ id }) => id)).size !== slots.length || new Set(slots.map(({ contentType }) => contentType)).size !== slots.length) throw new Error("Seed plan slot ids and content types must be unique.");
  const seen = new Set<string>();
  for (const slot of slots) {
    if (slot.dependsOn.some((dependency) => !seen.has(dependency))) throw new Error(`Seed plan slot ${slot.id} dependencies must appear earlier in load order.`);
    seen.add(slot.id);
  }
  const requirements = record(plan.sourceRequirements, "sourceRequirements must be an object.");
  exactKeys(requirements, ["format", "operatorSupplied", "licenseApprovalRequired", "attributionRequired", "provenanceRequired", "allowedLicenseBases", "approvedBy", "evidenceSchemes"], "sourceRequirements");
  if (requirements.format !== "next-dnd-snapshot-v2" || requirements.operatorSupplied !== true || requirements.licenseApprovalRequired !== true || requirements.attributionRequired !== true || requirements.provenanceRequired !== true) throw new Error("Seed source requirements may not weaken the approved evidence gate.");
  if (!Array.isArray(requirements.allowedLicenseBases) || requirements.allowedLicenseBases.length === 0 || requirements.allowedLicenseBases.some((item) => typeof item !== "string" || !LICENSE_BASES.has(item))) throw new Error("Seed plan license bases are unsupported.");
  if (!Array.isArray(requirements.approvedBy) || requirements.approvedBy.length === 0 || requirements.approvedBy.some((item) => typeof item !== "string" || !SLOT_ID.test(item) || /^(?:test|example|placeholder)/.test(item))) throw new Error("Seed plan approver allowlist is invalid.");
  if (!Array.isArray(requirements.evidenceSchemes) || requirements.evidenceSchemes.length === 0 || requirements.evidenceSchemes.some((item) => item !== "https:" && item !== "urn:")) throw new Error("Seed plan evidence schemes are unsupported.");
  if (!Array.isArray(plan.exclusions) || plan.exclusions.length === 0 || plan.exclusions.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Seed plan exclusions must be non-empty strings.");
  return { ...plan, slots } as unknown as SeedPlan;
}

export function validateInputs(value: unknown, plan: SeedPlan, now = new Date()): SeedInputs {
  const inputs = record(value, "Seed inputs must be an object.");
  exactKeys(inputs, ["schemaVersion", "planId", "slots"], "seed inputs");
  if (inputs.schemaVersion !== 1 || inputs.planId !== plan.planId || !Array.isArray(inputs.slots)) throw new Error("Seed inputs do not match the approved plan and schema.");
  const slots = inputs.slots.map((value, index) => {
    const slot = record(value, `Input slot ${index} must be an object.`);
    exactKeys(slot, ["slotId", "snapshotRoot", "manifestPath", "source"], `input slot ${index}`);
    text(slot.slotId, "slotId"); text(slot.snapshotRoot, "snapshotRoot"); text(slot.manifestPath, "manifestPath");
    if (isAbsolute(slot.snapshotRoot as string) || isAbsolute(slot.manifestPath as string)) throw new Error(`Input slot ${slot.slotId} snapshot paths must be relative to the input descriptor.`);
    const source = record(slot.source, `Input slot ${slot.slotId} source must be an object.`);
    exactKeys(source, ["canonicalSourceId", "title", "language", "category", "accessTier", "publicationCode", "publisher", "revision", "canonicalBookId", "originUrl", "originId", "attribution", "license", "licenseApproval"], `input slot ${slot.slotId} source`);
    for (const field of ["canonicalSourceId", "title", "publicationCode", "publisher", "revision", "canonicalBookId", "originUrl", "originId", "attribution", "license"] as const) text(source[field], field);
    if (!SLOT_ID.test(source.canonicalSourceId as string) || !SLOT_ID.test(source.canonicalBookId as string)) throw new Error(`Input slot ${slot.slotId} canonical source identifiers are invalid.`);
    if (!['en', 'ru'].includes(source.language as string) || !['core_rules', 'official_supplement'].includes(source.category as string) || source.accessTier !== 'open') throw new Error(`Input slot ${slot.slotId} source corpus fields are unapproved.`);
    const origin = new URL(source.originUrl as string);
    if (origin.href !== source.originUrl || origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new Error(`Input slot ${slot.slotId} originUrl must be canonical credential-free HTTPS without query or fragment.`);
    const approval = record(source.licenseApproval, `Input slot ${slot.slotId} licenseApproval must be an object.`);
    const approvalKeys = Object.keys(approval);
    if (approvalKeys.some((key) => !["basis", "approvedBy", "approvedAt", "evidenceUri", "evidenceSha256"].includes(key)) || approvalKeys.length !== 5) throw new Error(`input slot ${slot.slotId} licenseApproval contains missing or unknown fields.`);
    text(approval.basis, "basis"); text(approval.approvedBy, "approvedBy"); text(approval.evidenceUri, "evidenceUri"); timestamp(approval.approvedAt, "approvedAt");
    if (!plan.sourceRequirements.allowedLicenseBases.includes(approval.basis as string) || !plan.sourceRequirements.approvedBy.includes(approval.approvedBy as string)) throw new Error(`Input slot ${slot.slotId} license approval is outside the committed plan policy.`);
    if (Date.parse(approval.approvedAt as string) > now.getTime()) throw new Error(`Input slot ${slot.slotId} approval timestamp is in the future.`);
    const evidence = new URL(approval.evidenceUri as string);
    if (!plan.sourceRequirements.evidenceSchemes.includes(evidence.protocol) || evidence.username || evidence.password || evidence.search || evidence.hash) throw new Error(`Input slot ${slot.slotId} evidence URI is not permitted.`);
    if (typeof approval.evidenceSha256 !== "string" || !HASH.test(approval.evidenceSha256)) throw new Error(`Input slot ${slot.slotId} evidenceSha256 is invalid.`);
    return { ...slot, source: { ...source, licenseApproval: approval } } as unknown as SeedInputSlot;
  });
  const expected = [...new Set(plan.slots.map(({ inputSlotId }) => inputSlotId))].sort();
  const actual = slots.map(({ slotId }) => slotId).sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) throw new Error("Seed inputs must provide exactly one entry for every approved slot.");
  return { schemaVersion: 1, planId: plan.planId, slots };
}

export async function writeManifestAtomic(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  if (relative(directory, temporary).startsWith("..")) throw new Error("Manifest temporary path escaped its output directory.");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(redact(value), null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    if (handle.fd !== -1) await handle.close();
  }
  await rename(temporary, target);
  const directoryHandle = await open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return typeof value === "string" ? redactString(value) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey(key) ? "[REDACTED]" : redact(item)]));
}

function validateSnapshot(value: unknown, slot: SeedPlanSlot): NextDndSnapshotManifest {
  const manifest = record(value, `Slot ${slot.id} manifest must be an object.`) as unknown as NextDndSnapshotManifest;
  if (manifest.schemaVersion !== 2 || manifest.parserVersion !== NEXT_DND_PARSER_VERSION || manifest.status !== "complete" || manifest.robots === null || manifest.robots.userAgent !== "dnd.firegory.site-snapshot" || manifest.parserFailures?.length !== 0) throw new Error(`Slot ${slot.id} requires a complete current-parser snapshot manifest.`);
  if (!Array.isArray(manifest.categories) || manifest.categories.length !== 1 || manifest.categories[0].requestedCategory !== slot.snapshotCategory || manifest.categories[0].discoveredCategory !== slot.snapshotCategory || !manifest.categories[0].index || manifest.categories[0].entryCount < 1 || manifest.categories[0].details.length !== manifest.categories[0].entryCount) throw new Error(`Slot ${slot.id} manifest must contain exactly its approved non-empty complete category.`);
  const requiredEvaluations = [manifest.categories[0].index.sourceUrl, ...manifest.categories[0].details.map((detail: SnapshotDetail) => detail.sourceUrl)];
  if (requiredEvaluations.some((sourceUrl) => !manifest.robots!.evaluations.some((evaluation) => evaluation.sourceUrl === sourceUrl && evaluation.allowed))) throw new Error(`Slot ${slot.id} snapshot lacks an allowed robots evaluation.`);
  if (new Set(manifest.categories[0].details.map((detail: SnapshotDetail) => detail.externalId)).size !== manifest.categories[0].details.length) throw new Error(`Slot ${slot.id} snapshot contains duplicate detail identities.`);
  timestamp(manifest.collectedAt, "collectedAt");
  return manifest;
}

async function validateSnapshotBlobs(manifest: NextDndSnapshotManifest, root: string, canonicalSourceId: string): Promise<PreparedSeedSlot["evidenceFiles"]> {
  const resources = [manifest.robots!.snapshot, ...manifest.categories.flatMap(({ index, details }) => [index!, ...details])];
  const bytesByPath = new Map<string, Buffer>();
  const evidenceByHash = new Map<string, PreparedSeedSlot["evidenceFiles"][number]>();
  for (const resource of resources) {
    if (!HASH.test(resource.sha256) || !Number.isSafeInteger(resource.byteLength) || resource.byteLength < 1) throw new Error(`Snapshot resource ${resource.sourceUrl} has invalid content metadata.`);
    if (resource.parserVersion !== NEXT_DND_PARSER_VERSION) throw new Error(`Snapshot resource ${resource.sourceUrl} uses an unapproved parser version.`);
    const sourceUrl = new URL(resource.sourceUrl);
    const finalUrl = new URL(resource.finalUrl);
    if (sourceUrl.href !== resource.sourceUrl || finalUrl.href !== resource.finalUrl
      || sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "next.dnd.su" || sourceUrl.port || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash
      || finalUrl.protocol !== "https:" || finalUrl.hostname !== "next.dnd.su" || finalUrl.port || finalUrl.username || finalUrl.password || finalUrl.search || finalUrl.hash) throw new Error(`Snapshot resource ${resource.sourceUrl} is outside the approved origin or not canonical.`);
    const path = resolve(root, resource.blobPath);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Snapshot resource ${resource.sourceUrl} has an unsafe blobPath.`);
    const bytes = await readStableFile(path, root, `snapshot resource ${resource.sourceUrl}`);
    if (bytes.byteLength !== resource.byteLength || sha256(bytes) !== resource.sha256) throw new Error(`Snapshot blob integrity check failed for ${resource.sourceUrl}.`);
    bytesByPath.set(resource.blobPath, bytes);
    evidenceByHash.set(resource.sha256, { sha256: resource.sha256, byteLength: bytes.byteLength, mediaType: "text/html", bytes,
      canonicalPath: `sources/${canonicalSourceId}/evidence/${resource.sha256}.html` });
  }
  const category = manifest.categories[0];
  const indexBytes = bytesByPath.get(category.index!.blobPath)!;
  const parsedIndex = parseNextDndIndex(indexBytes.toString("utf8"), category.index!.sourceUrl, category.requestedCategory);
  if (parsedIndex.entries.length !== category.entryCount) throw new Error(`Snapshot category ${category.requestedCategory} discovery count does not match its raw index.`);
  const parsedById = new Map(parsedIndex.entries.map((entry) => [entry.externalId, entry]));
  for (const detail of category.details) {
    const parsedIndexEntry = parsedById.get(detail.externalId);
    if (!parsedIndexEntry || parsedIndexEntry.sourceUrl !== detail.sourceUrl || canonicalJson(parsedIndexEntry.metadata) !== canonicalJson(detail.indexMetadata)
      || parsedIndexEntry.cardFingerprintSha256 !== detail.indexSource.cardFingerprintSha256
      || detail.indexSource.url !== category.index!.sourceUrl || detail.indexSource.fingerprintSha256 !== category.index!.sha256
      || detail.indexSource.rawBlobPath !== category.index!.blobPath || detail.indexSource.fetchedAt !== category.index!.fetchedAt) {
      throw new Error(`Snapshot detail ${detail.externalId} does not match its raw index evidence.`);
    }
    const parsedDetail = parseNextDndDetail(bytesByPath.get(detail.blobPath)!.toString("utf8"), category.requestedCategory, detail.externalId);
    if (canonicalJson(parsedDetail) !== canonicalJson(detail.normalized)) throw new Error(`Snapshot detail ${detail.externalId} normalized content does not match its raw blob.`);
  }
  return [...evidenceByHash.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

function durableManifest(manifest: NextDndSnapshotManifest, canonicalSourceId: string): NextDndSnapshotManifest {
  const durablePath = (hash: string) => `sources/${canonicalSourceId}/evidence/${hash}.html`;
  const resource = <T extends { sha256: string; blobPath: string }>(value: T): T => ({ ...value, blobPath: durablePath(value.sha256) });
  return {
    ...manifest,
    robots: manifest.robots ? { ...manifest.robots, snapshot: resource(manifest.robots.snapshot) } : null,
    categories: manifest.categories.map((category) => ({
      ...category,
      index: category.index ? resource(category.index) : null,
      details: category.details.map((detail) => ({
        ...resource(detail),
        indexSource: { ...detail.indexSource, rawBlobPath: durablePath(detail.indexSource.fingerprintSha256) },
      })),
    })),
  };
}

async function readStableFile(path: string, allowedRoot: string, label: string): Promise<Buffer> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(resolve(allowedRoot), absolute, label);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular no-follow file.`);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    const physicalRoot = await realpath(resolve(allowedRoot));
    const openedRelative = relative(physicalRoot, openedPath);
    if (openedRelative === ".." || openedRelative.startsWith(`..${sep}`) || isAbsolute(openedRelative)) throw new Error(`${label} escaped its approved root while it was opened.`);
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || openedBefore.dev !== before.dev || openedBefore.ino !== before.ino) throw new Error(`${label} changed while it was opened.`);
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    if (openedAfter.dev !== openedBefore.dev || openedAfter.ino !== openedBefore.ino || openedAfter.size !== openedBefore.size
      || openedAfter.mtimeNs !== openedBefore.mtimeNs || BigInt(bytes.byteLength) !== openedBefore.size) throw new Error(`${label} changed while it was read.`);
    return bytes;
  } finally { await handle.close(); }
}

async function assertNoSymlinkComponents(root: string, target: string, label: string): Promise<void> {
  const base = resolve(root);
  const absolute = resolve(target);
  const fromRoot = relative(base, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    if (fromRoot === "") {
      const metadata = await lstat(base);
      if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link.`);
      return;
    }
    throw new Error(`${label} escapes its approved root.`);
  }
  let current = base;
  const rootMetadata = await lstat(current);
  if (rootMetadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link.`);
  for (const component of fromRoot.split(sep)) {
    current = resolve(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link.`);
  }
  const physicalRoot = await realpath(base);
  const physicalTarget = await realpath(absolute);
  const physicalRelative = relative(physicalRoot, physicalTarget);
  if (physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) throw new Error(`${label} physically escapes its approved root.`);
}

export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error("Value is not JSON serializable."); return encoded;
}
function parseJson(bytes: Buffer, label: string): unknown { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON.`); } }
function record(value: unknown, message: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void { const expected = [...keys].sort(); const actual = Object.keys(value).sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} contains missing or unknown fields.`); }
function text(value: unknown, field: string): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 1000 || value !== value.trim() || value !== value.normalize("NFC")) throw new Error(`${field} must be a canonical non-empty bounded string.`); }
function timestamp(value: unknown, field: string): asserts value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp.`); }
function redactString(value: string): string {
  let result = value.replace(/\bpostgres(?:ql)?:\/\/[^\s]+/giu, "[REDACTED_DATABASE_URL]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED_AUTH]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\b(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret)\s*[=:]\s*[^\s&,;]+/giu, "[REDACTED_CREDENTIAL]");
  result = result.replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s]+/giu, (candidate) => redactUrl(candidate));
  return result;
}
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) { url.username = "REDACTED"; url.password = "REDACTED"; }
    for (const key of [...url.searchParams.keys()]) if (sensitiveKey(key)) url.searchParams.set(key, "REDACTED");
    return url.toString();
  } catch { return "[REDACTED_URL]"; }
}
function sensitiveKey(key: string): boolean {
  if (/redacted$/i.test(key)) return false;
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ["password", "passwd", "pwd", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "authorization", "cookie", "setcookie", "databaseurl", "apikey", "credential", "credentials"].some((item) => normalized === item || normalized.endsWith(item) || normalized.startsWith(item));
}
