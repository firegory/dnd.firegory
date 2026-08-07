import type { QueryResultRow } from "pg";

import { withTransaction } from "../db/client.ts";

export const COMPENDIUM_ENTRY_TYPES = [
  "spell", "creature", "item", "class", "feature", "species", "background", "feat", "equipment",
] as const;
export type CompendiumEntryType = (typeof COMPENDIUM_ENTRY_TYPES)[number];
export type CompendiumEdition = "5e" | "5.5e";
export type CompendiumLanguage = "en" | "ru";

type DbClient = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}>;
type TransactionRunner = <T>(callback: (client: DbClient) => Promise<T>) => Promise<T>;

export type CitationInput = Readonly<{
  chunkId: string;
  generationId: string;
  kind: "field" | "block";
  fieldPath?: string | null;
  blockOrder: number;
  quote: string;
  quoteSpanStart: number;
  quoteSpanEnd: number;
}>;

type ExtensionData = Readonly<Record<string, unknown>>;
type ProjectionBase = Readonly<{ extensionData?: ExtensionData }>;
export type ProjectionInput =
  | (ProjectionBase & Readonly<{ type: "spell"; level: number; school: "abjuration" | "conjuration" | "divination" | "enchantment" | "evocation" | "illusion" | "necromancy" | "transmutation"; castingTime: string; range: string; duration: string; components: string; concentration?: boolean; ritual?: boolean }>)
  | (ProjectionBase & Readonly<{ type: "creature"; size: "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan"; creatureType: string; alignment?: string | null; armorClass: number; hitPoints: number; challengeRating: number; speed: string }>)
  | (ProjectionBase & Readonly<{ type: "item"; category: "armor" | "potion" | "ring" | "rod" | "scroll" | "staff" | "wand" | "weapon" | "wondrous" | "other"; rarity: "common" | "uncommon" | "rare" | "very_rare" | "legendary" | "artifact" | "varies"; requiresAttunement?: boolean }>)
  | (ProjectionBase & Readonly<{ type: "class"; hitDie: 6 | 8 | 10 | 12; primaryAbility: string; spellcastingAbility?: string | null }>)
  | (ProjectionBase & Readonly<{ type: "feature"; level: number; featureKind: string }>)
  | (ProjectionBase & Readonly<{ type: "species"; size: "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan"; speed: number }>)
  | (ProjectionBase & Readonly<{ type: "background"; abilityScores: string; skillProficiencies: string }>)
  | (ProjectionBase & Readonly<{ type: "feat"; category: "origin" | "general" | "fighting_style" | "epic_boon"; prerequisiteLevel?: number | null; prerequisiteText?: string | null; repeatable?: boolean }>)
  | (ProjectionBase & Readonly<{ type: "equipment"; category: "adventuring_gear" | "ammunition" | "armor" | "focus" | "mount" | "tool" | "vehicle" | "weapon" | "other"; costCp?: number | null; weightLb?: number | null }>);

export type CreateCompendiumDraftInput = Readonly<{
  canonicalKey: string;
  entryType: CompendiumEntryType;
  edition: CompendiumEdition;
  language: CompendiumLanguage;
  sourceId: string;
  fileId: string;
  slug: string;
  aliases?: readonly string[];
  title: string;
  summary?: string | null;
  body: string;
  extensionData?: ExtensionData;
  projection: ProjectionInput;
  citations?: readonly CitationInput[];
  actor?: string;
  reason?: string;
}>;

export type CreateCompendiumRevisionInput = Readonly<{
  title: string;
  summary?: string | null;
  body: string;
  extensionData?: ExtensionData;
  projection: ProjectionInput;
  citations?: readonly CitationInput[];
  basedOnRevisionId?: string;
  actor?: string;
  reason?: string;
}>;

export type CreatedCompendiumDraft = Readonly<{ entryId: string; versionId: string; revisionId: string }>;

export class CompendiumValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompendiumValidationError";
  }
}

export class CompendiumService {
  private readonly transaction: TransactionRunner;

  constructor(transaction: TransactionRunner = withTransaction as TransactionRunner) {
    this.transaction = transaction;
  }

  async createDraft(input: CreateCompendiumDraftInput): Promise<CreatedCompendiumDraft> {
    validateDraft(input);
    return this.transaction(async (client) => {
      const owner = await client.query<{ source_id: string; edition: CompendiumEdition; language: CompendiumLanguage }>(
        `SELECT f.source_id, s.edition, s.language
         FROM files f JOIN sources s ON s.id = f.source_id
         WHERE f.id = $1 AND f.source_id = $2 AND f.deleted_at IS NULL AND s.deleted_at IS NULL
         FOR SHARE OF f, s`,
        [input.fileId, input.sourceId],
      );
      const boundary = owner.rows[0];
      if (!boundary || boundary.edition !== input.edition || boundary.language !== input.language) {
        throw new CompendiumValidationError("The version edition/language must match its exact source and file boundary.");
      }

      const entry = await client.query<{ id: string }>(
        `INSERT INTO compendium_entries (canonical_key, entry_type, edition)
         VALUES ($1, $2, $3)
         ON CONFLICT (entry_type, edition, canonical_key)
         DO UPDATE SET canonical_key = EXCLUDED.canonical_key
         RETURNING id`,
        [input.canonicalKey, input.entryType, input.edition],
      );
      const entryId = requiredRow(entry.rows[0], "Unable to create or resolve compendium entry.").id;
      const version = await client.query<{ id: string; active_revision_id: string }>(
        `INSERT INTO compendium_versions
           (entry_id, entry_type, edition, language, source_id, file_id, lifecycle, active_revision_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', gen_random_uuid())
         RETURNING id, active_revision_id`,
        [entryId, input.entryType, input.edition, input.language, input.sourceId, input.fileId],
      );
      const versionRow = requiredRow(version.rows[0], "Unable to create compendium version.");
      const versionId = versionRow.id;
      const revision = await client.query<{ id: string }>(
         `INSERT INTO compendium_revisions
            (id, version_id, entry_type, revision_number, lifecycle, title, summary, body, extension_data, created_by, change_reason)
          VALUES ($1, $2, $3, 1, 'draft', $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
         [versionRow.active_revision_id, versionId, input.entryType, input.title.trim(), input.summary?.trim() || null, input.body, json(input.extensionData), input.actor ?? null, input.reason?.trim() || null],
      );
      const revisionId = requiredRow(revision.rows[0], "Unable to create compendium revision.").id;

      for (const [kind, name] of [["slug", input.slug], ...((input.aliases ?? []).map((alias) => ["alias", alias] as const))] as const) {
        await client.query(
          `INSERT INTO compendium_names (version_id, entry_id, entry_type, edition, language, kind, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [versionId, entryId, input.entryType, input.edition, input.language, kind, name.trim()],
        );
      }

      await insertProjection(client, revisionId, input.projection);
      for (const citation of input.citations ?? []) {
        await insertCitation(client, revisionId, versionId, input.sourceId, input.fileId, citation);
      }
      if (input.actor && input.reason) await insertEditorAudit(client, versionId, revisionId, "revision_created", input.actor, input.reason);
      return { entryId, versionId, revisionId };
    });
  }

  async publishRevision(versionId: string, revisionId: string): Promise<void> {
    requireUuid(versionId, "versionId");
    requireUuid(revisionId, "revisionId");
    await this.transaction(async (client) => {
      const result = await client.query<{ version_lifecycle: string; revision_lifecycle: string }>(
        `SELECT v.lifecycle AS version_lifecycle, r.lifecycle AS revision_lifecycle
         FROM compendium_versions v
         JOIN compendium_revisions r ON r.version_id = v.id
         WHERE v.id = $1 AND r.id = $2 FOR UPDATE OF v, r`,
        [versionId, revisionId],
      );
      const state = result.rows[0];
      if (!state) throw new CompendiumValidationError("Revision does not belong to the requested version.");
      if (state.version_lifecycle === "retired") throw new CompendiumValidationError("A retired version cannot be published.");
      const generationStates = await client.query<{ status: string }>(
        `SELECT g.status FROM compendium_citations c
         JOIN ingestion_generations g ON g.id = c.generation_id
         WHERE c.revision_id = $1
         FOR SHARE OF g`,
        [revisionId],
      );
      if (generationStates.rows.some(({ status }) => status !== "active" && status !== "archived")) {
        throw new CompendiumValidationError("Revision citations must remain in active or archived generations.");
      }
      const importStates = await client.query<{ status: string }>(
        `SELECT run.status FROM compendium_import_links link
         JOIN compendium_import_occurrences occurrence ON occurrence.id = link.occurrence_id
         JOIN compendium_import_runs run ON run.id = occurrence.import_run_id
         WHERE link.revision_id = $1 FOR SHARE OF link, occurrence, run`,
        [revisionId],
      );
      if (importStates.rows.some(({ status }) => status !== "succeeded")) {
        throw new CompendiumValidationError("Failed or partial import runs cannot publish revisions.");
      }
      if (state.revision_lifecycle === "draft") {
        await client.query(
          `UPDATE compendium_revisions SET lifecycle = 'published', published_at = now()
           WHERE id = $1 AND version_id = $2 AND lifecycle = 'draft'`,
          [revisionId, versionId],
        );
      } else if (state.revision_lifecycle !== "published") {
        throw new CompendiumValidationError("Only draft or already-published revisions can become active.");
      }
      await client.query(
        `UPDATE compendium_versions
         SET lifecycle = 'published', active_revision_id = $2, published_at = coalesce(published_at, now()), retired_at = NULL
         WHERE id = $1`,
        [versionId, revisionId],
      );
    });
  }

  async createRevision(versionId: string, input: CreateCompendiumRevisionInput): Promise<string> {
    requireUuid(versionId, "versionId");
    validateRevision(input);
    return this.transaction(async (client) => {
      const version = await client.query<{
        entry_type: CompendiumEntryType;
        lifecycle: string;
        source_id: string;
        file_id: string;
        active_revision_id: string;
      }>(
       `SELECT entry_type, lifecycle, source_id, file_id, active_revision_id
          FROM compendium_versions WHERE id = $1 FOR UPDATE`,
        [versionId],
      );
       const owner = requiredRow(version.rows[0], "Compendium version was not found.");
       if (owner.lifecycle === "retired") throw new CompendiumValidationError("A retired version cannot receive revisions.");
       if (input.projection.type !== owner.entry_type) throw new CompendiumValidationError("Projection type must match the version entry type.");
       if (input.basedOnRevisionId) {
         requireUuid(input.basedOnRevisionId, "basedOnRevisionId");
         if (owner.active_revision_id !== input.basedOnRevisionId) throw new CompendiumValidationError("The entry changed after this editor was opened. Reload before saving a correction.");
       }
      const sequence = await client.query<{ revision_number: number }>(
        `SELECT coalesce(max(revision_number), 0) + 1 AS revision_number
         FROM compendium_revisions WHERE version_id = $1`,
        [versionId],
      );
      const revisionNumber = requiredRow(sequence.rows[0], "Unable to allocate revision number.").revision_number;
      const inserted = await client.query<{ id: string }>(
         `INSERT INTO compendium_revisions
            (version_id, entry_type, revision_number, lifecycle, title, summary, body, extension_data,
             based_on_revision_id, created_by, change_reason)
          VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING id`,
         [versionId, owner.entry_type, revisionNumber, input.title.trim(), input.summary?.trim() || null, input.body, json(input.extensionData), input.basedOnRevisionId ?? null, input.actor ?? null, input.reason?.trim() || null],
      );
      const revisionId = requiredRow(inserted.rows[0], "Unable to create compendium revision.").id;
      await insertProjection(client, revisionId, input.projection);
      for (const citation of input.citations ?? []) {
        await insertCitation(client, revisionId, versionId, owner.source_id, owner.file_id, citation);
      }
      if (input.actor && input.reason) await insertEditorAudit(client, versionId, revisionId, "revision_created", input.actor, input.reason);
      if (owner.lifecycle === "draft") {
        await client.query(
          "UPDATE compendium_versions SET active_revision_id = $2 WHERE id = $1 AND lifecycle = 'draft'",
          [versionId, revisionId],
        );
      }
      return revisionId;
    });
  }

  async createRelation(input: Readonly<{
    sourceEntryId: string;
    targetEntryId: string;
    relationType: "related" | "requires" | "grants" | "replaces" | "member_of" | "prerequisite";
  }>): Promise<string> {
    // Relations are not visible to readers until an import occurrence links
    // source-bound evidence through compendium_import_links.
    requireUuid(input.sourceEntryId, "sourceEntryId");
    requireUuid(input.targetEntryId, "targetEntryId");
    enumValue(input.relationType, ["related", "requires", "grants", "replaces", "member_of", "prerequisite"], "relationType");
    if (input.sourceEntryId === input.targetEntryId) throw new CompendiumValidationError("Relations cannot target the same entry.");
    return this.transaction(async (client) => {
      const entries = await client.query<{ id: string; edition: CompendiumEdition }>(
        "SELECT id, edition FROM compendium_entries WHERE id = ANY($1::uuid[]) FOR SHARE",
        [[input.sourceEntryId, input.targetEntryId]],
      );
      const source = entries.rows.find((row) => row.id === input.sourceEntryId);
      const target = entries.rows.find((row) => row.id === input.targetEntryId);
      if (!source || !target) throw new CompendiumValidationError("Both relation entries must exist.");
      if (source.edition !== target.edition) throw new CompendiumValidationError("Compendium relations cannot cross editions.");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO compendium_entry_relations (source_entry_id, target_entry_id, edition, relation_type)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.sourceEntryId, input.targetEntryId, source.edition, input.relationType],
      );
      return requiredRow(inserted.rows[0], "Unable to create compendium relation.").id;
    });
  }
}

export function validateDraft(input: CreateCompendiumDraftInput): void {
  if (!COMPENDIUM_ENTRY_TYPES.includes(input.entryType)) throw new CompendiumValidationError("Unsupported entry type.");
  enumValue(input.edition, ["5e", "5.5e"], "edition");
  enumValue(input.language, ["en", "ru"], "language");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(input.canonicalKey)) throw new CompendiumValidationError("canonicalKey must be a stable lowercase key.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(input.slug)) throw new CompendiumValidationError("slug must be a stable lowercase slug.");
  requireUuid(input.sourceId, "sourceId");
  requireUuid(input.fileId, "fileId");
  if (input.projection.type !== input.entryType) throw new CompendiumValidationError("Projection type must match entry type.");
  validateRevision(input);
  const normalized = new Set<string>();
  for (const name of [input.slug, ...(input.aliases ?? [])]) {
    const key = normalizeName(name);
    if (!key) throw new CompendiumValidationError("Aliases cannot be blank.");
    if (normalized.has(key)) throw new CompendiumValidationError("Slug and aliases conflict after normalization.");
    normalized.add(key);
  }
}

function validateRevision(input: CreateCompendiumRevisionInput): void {
  if (!input.title?.trim() || !input.body?.trim()) throw new CompendiumValidationError("title and body are required.");
  if ((input.actor === undefined) !== (input.reason === undefined) || (input.actor !== undefined && (!input.actor.trim() || !input.reason!.trim() || input.reason!.trim().length > 1_000))) throw new CompendiumValidationError("actor and a reason of at most 1000 characters must be supplied together.");
  if (input.basedOnRevisionId !== undefined) requireUuid(input.basedOnRevisionId, "basedOnRevisionId");
  validateObject(input.extensionData, "extensionData");
  validateProjection(input.projection);
  for (const citation of input.citations ?? []) validateCitation(citation);
}

export function validateCitation(citation: CitationInput, chunkQuote?: string): void {
  requireUuid(citation.chunkId, "citation.chunkId");
  requireUuid(citation.generationId, "citation.generationId");
  enumValue(citation.kind, ["field", "block"], "citation.kind");
  if (!Number.isSafeInteger(citation.blockOrder) || citation.blockOrder < 0 || citation.blockOrder > 2147483647) throw new CompendiumValidationError("Citation blockOrder must fit a nonnegative PostgreSQL integer.");
  if (citation.kind === "field" && (typeof citation.fieldPath !== "string" || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/.test(citation.fieldPath))) throw new CompendiumValidationError("Field citations require a JSON-style fieldPath.");
  if (citation.kind === "block" && citation.fieldPath != null) throw new CompendiumValidationError("Block citations cannot have fieldPath.");
  if (!Number.isSafeInteger(citation.quoteSpanStart) || !Number.isSafeInteger(citation.quoteSpanEnd) || citation.quoteSpanStart < 0 || citation.quoteSpanEnd <= citation.quoteSpanStart) throw new CompendiumValidationError("Citation spans must be positive half-open offsets.");
  if (typeof citation.quote !== "string") throw new CompendiumValidationError("Citation quote must be text.");
  const quoteCodePoints = Array.from(citation.quote);
  if (quoteCodePoints.length === 0 || quoteCodePoints.length !== citation.quoteSpanEnd - citation.quoteSpanStart) throw new CompendiumValidationError("Citation quote code-point length must equal its span.");
  if (chunkQuote !== undefined && Array.from(chunkQuote).slice(citation.quoteSpanStart, citation.quoteSpanEnd).join("") !== citation.quote) throw new CompendiumValidationError("Citation quote must exactly match chunk quote_text at its code-point span.");
}

function validateProjection(projection: ProjectionInput): void {
  validateObject(projection.extensionData, "projection.extensionData");
  switch (projection.type) {
    case "spell":
      integerRange(projection.level, 0, 9, "spell.level");
      enumValue(projection.school, ["abjuration", "conjuration", "divination", "enchantment", "evocation", "illusion", "necromancy", "transmutation"], "spell.school");
      requireText(projection.castingTime, "spell.castingTime"); requireText(projection.range, "spell.range"); requireText(projection.duration, "spell.duration"); requireText(projection.components, "spell.components"); optionalBoolean(projection.concentration, "spell.concentration"); optionalBoolean(projection.ritual, "spell.ritual"); return;
    case "creature":
      enumValue(projection.size, ["tiny", "small", "medium", "large", "huge", "gargantuan"], "creature.size");
      integerRange(projection.armorClass, 0, 50, "creature.armorClass"); integerRange(projection.hitPoints, 1, 2147483647, "creature.hitPoints"); challengeRating(projection.challengeRating); requireText(projection.creatureType, "creature.creatureType"); requireText(projection.speed, "creature.speed"); optionalText(projection.alignment, "creature.alignment"); return;
    case "class": if (![6, 8, 10, 12].includes(projection.hitDie)) throw new CompendiumValidationError("class.hitDie must be d6, d8, d10, or d12."); requireText(projection.primaryAbility, "class.primaryAbility"); optionalText(projection.spellcastingAbility, "class.spellcastingAbility"); return;
    case "feature": integerRange(projection.level, 1, 20, "feature.level"); requireText(projection.featureKind, "feature.featureKind"); return;
    case "species": enumValue(projection.size, ["tiny", "small", "medium", "large", "huge", "gargantuan"], "species.size"); integerRange(projection.speed, 1, 2147483647, "species.speed"); return;
    case "background": requireText(projection.abilityScores, "background.abilityScores"); requireText(projection.skillProficiencies, "background.skillProficiencies"); return;
    case "feat": enumValue(projection.category, ["origin", "general", "fighting_style", "epic_boon"], "feat.category"); if (projection.prerequisiteLevel != null) integerRange(projection.prerequisiteLevel, 1, 20, "feat.prerequisiteLevel"); optionalText(projection.prerequisiteText, "feat.prerequisiteText"); optionalBoolean(projection.repeatable, "feat.repeatable"); return;
    case "equipment": enumValue(projection.category, ["adventuring_gear", "ammunition", "armor", "focus", "mount", "tool", "vehicle", "weapon", "other"], "equipment.category"); if (projection.costCp != null) integerRange(projection.costCp, 0, 2147483647, "equipment.costCp"); if (projection.weightLb != null) decimalRange(projection.weightLb, 0, 9999999.999, 3, "equipment.weightLb"); return;
    case "item": enumValue(projection.category, ["armor", "potion", "ring", "rod", "scroll", "staff", "wand", "weapon", "wondrous", "other"], "item.category"); enumValue(projection.rarity, ["common", "uncommon", "rare", "very_rare", "legendary", "artifact", "varies"], "item.rarity"); optionalBoolean(projection.requiresAttunement, "item.requiresAttunement"); return;
  }
}

async function insertCitation(client: DbClient, revisionId: string, versionId: string, sourceId: string, fileId: string, citation: CitationInput): Promise<void> {
  const chunk = await client.query<{ quote_text: string; generation_status: string }>(
    `SELECT c.quote_text, g.status AS generation_status FROM chunks c
     JOIN ingestion_generations g
       ON g.id = c.generation_id AND g.file_id = c.file_id AND g.source_id = c.source_id
     WHERE c.id = $1 AND c.generation_id = $2 AND c.file_id = $3 AND c.source_id = $4
       AND g.status IN ('active', 'archived')
     FOR SHARE OF c, g`,
    [citation.chunkId, citation.generationId, fileId, sourceId],
  );
  if (!chunk.rows[0]) throw new CompendiumValidationError("Citation chunk is outside the version source/file boundary.");
  validateCitation(citation, chunk.rows[0].quote_text);
  await client.query(
    `INSERT INTO compendium_citations
       (revision_id, version_id, source_id, file_id, generation_id, chunk_id, kind, field_path,
        block_order, quote, quote_span_start, quote_span_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [revisionId, versionId, sourceId, fileId, citation.generationId, citation.chunkId, citation.kind, citation.fieldPath ?? null, citation.blockOrder, citation.quote, citation.quoteSpanStart, citation.quoteSpanEnd],
  );
}

async function insertProjection(client: DbClient, revisionId: string, projection: ProjectionInput): Promise<void> {
  const extension = json(projection.extensionData);
  switch (projection.type) {
    case "spell": await client.query("INSERT INTO compendium_spells (revision_id, level, school, casting_time, range_text, duration, components, concentration, ritual, extension_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)", [revisionId, projection.level, projection.school, projection.castingTime.trim(), projection.range.trim(), projection.duration.trim(), projection.components.trim(), projection.concentration ?? false, projection.ritual ?? false, extension]); return;
    case "creature": await client.query("INSERT INTO compendium_creatures (revision_id, size, creature_type, alignment, armor_class, hit_points, challenge_rating, speed, extension_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)", [revisionId, projection.size, projection.creatureType.trim(), projection.alignment?.trim() || null, projection.armorClass, projection.hitPoints, projection.challengeRating, projection.speed.trim(), extension]); return;
    case "item": await client.query("INSERT INTO compendium_items (revision_id, category, rarity, requires_attunement, extension_data) VALUES ($1,$2,$3,$4,$5::jsonb)", [revisionId, projection.category, projection.rarity, projection.requiresAttunement ?? false, extension]); return;
    case "class": await client.query("INSERT INTO compendium_classes (revision_id, hit_die, primary_ability, spellcasting_ability, extension_data) VALUES ($1,$2,$3,$4,$5::jsonb)", [revisionId, projection.hitDie, projection.primaryAbility.trim(), projection.spellcastingAbility?.trim() || null, extension]); return;
    case "feature": await client.query("INSERT INTO compendium_features (revision_id, level, feature_kind, extension_data) VALUES ($1,$2,$3,$4::jsonb)", [revisionId, projection.level, projection.featureKind.trim(), extension]); return;
    case "species": await client.query("INSERT INTO compendium_species (revision_id, size, speed, extension_data) VALUES ($1,$2,$3,$4::jsonb)", [revisionId, projection.size, projection.speed, extension]); return;
    case "background": await client.query("INSERT INTO compendium_backgrounds (revision_id, ability_scores, skill_proficiencies, extension_data) VALUES ($1,$2,$3,$4::jsonb)", [revisionId, projection.abilityScores.trim(), projection.skillProficiencies.trim(), extension]); return;
    case "feat": await client.query("INSERT INTO compendium_feats (revision_id, category, prerequisite_level, prerequisite_text, repeatable, extension_data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [revisionId, projection.category, projection.prerequisiteLevel ?? null, projection.prerequisiteText?.trim() || null, projection.repeatable ?? false, extension]); return;
    case "equipment": await client.query("INSERT INTO compendium_equipment (revision_id, category, cost_cp, weight_lb, extension_data) VALUES ($1,$2,$3,$4,$5::jsonb)", [revisionId, projection.category, projection.costCp ?? null, projection.weightLb ?? null, extension]); return;
  }
}

function normalizeName(value: string): string { return typeof value === "string" ? value.normalize("NFC").trim().toLowerCase().replace(/[\s._,/:;!?()-]+/gu, "-").replace(/^-|-$/g, "") : ""; }
function requireUuid(value: string, field: string): void { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CompendiumValidationError(`${field} must be a UUID.`); }
function requireText(value: string, field: string): void { if (typeof value !== "string" || !value.trim()) throw new CompendiumValidationError(`${field} is required.`); }
function optionalText(value: string | null | undefined, field: string): void { if (value != null && typeof value !== "string") throw new CompendiumValidationError(`${field} must be text or null.`); }
function optionalBoolean(value: boolean | undefined, field: string): void { if (value !== undefined && typeof value !== "boolean") throw new CompendiumValidationError(`${field} must be boolean.`); }
function integerRange(value: number, min: number, max: number, field: string): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new CompendiumValidationError(`${field} must be an integer between ${min} and ${max}.`); }
function numberRange(value: number, min: number, max: number, field: string): void { if (!Number.isFinite(value) || value < min || value > max) throw new CompendiumValidationError(`${field} must be between ${min} and ${max}.`); }
function decimalRange(value: number, min: number, max: number, scale: number, field: string): void {
  numberRange(value, min, max, field);
  const scaled = value * 10 ** scale;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;
  if (Math.abs(scaled - Math.round(scaled)) > tolerance) {
    throw new CompendiumValidationError(`${field} supports at most ${scale} decimal places.`);
  }
}
function challengeRating(value: number): void { if (![0, 0.125, 0.25, 0.5].includes(value) && (!Number.isInteger(value) || value < 1 || value > 30)) throw new CompendiumValidationError("creature.challengeRating must be 0, 1/8, 1/4, 1/2, or an integer from 1 to 30."); }
function validateObject(value: ExtensionData | undefined, field: string): void { if (value !== undefined && (value === null || Array.isArray(value) || typeof value !== "object")) throw new CompendiumValidationError(`${field} must be an object.`); }
function enumValue(value: string, allowed: readonly string[], field: string): void { if (!allowed.includes(value)) throw new CompendiumValidationError(`${field} must be one of: ${allowed.join(", ")}.`); }
function json(value: ExtensionData | undefined): string { return JSON.stringify(value ?? {}); }
async function insertEditorAudit(client: DbClient, versionId: string, revisionId: string, eventType: string, actor: string, reason: string): Promise<void> {
  await client.query(
    `INSERT INTO compendium_editor_audit (version_id, revision_id, event_type, actor, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [versionId, revisionId, eventType, actor, reason.trim()],
  );
}
function requiredRow<T>(row: T | undefined, message: string): T { if (!row) throw new CompendiumValidationError(message); return row; }
