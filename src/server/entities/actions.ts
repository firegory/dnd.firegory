import { query, withTransaction } from "../db/client.ts";import {
  createIngestionJob,
  markJobFailed,
  markJobProcessing,
  markJobSucceeded,
  updateJobProgress,
  type IngestionJobRecord,
} from "../ingestion/storage.ts";
import { enqueueJob } from "../ingestion/queue.ts";
import {
  deleteEntitiesForFile,
  persistEntities,
  listSourceFiles,
  loadChunksForFile,
  linkChildEntities,
} from "../entities/storage.ts";
import { identifyEntities, type ExtractionChunk } from "../../worker/ingestion/entity-extract.ts";
import { chatCompletion } from "../llm/client.ts";
import type { EntityInput, EntityType } from "../entities/types.ts";

export async function createEntityExtractionJob(
  sourceId: string,
  requestedByUserId: string,
): Promise<{ job: IngestionJobRecord; queueId: string }> {
  const sourceCheck = await query<{
    id: string;
    deleted_at: string | null;
  }>("SELECT id, deleted_at FROM sources WHERE id = $1", [sourceId]);
  if (sourceCheck.rows.length === 0) {
    throw new Error(`Source not found: ${sourceId}`);
  }
  if (sourceCheck.rows[0].deleted_at !== null) {
    throw new Error(`Source ${sourceId} has been deleted.`);
  }

  const job = await withTransaction(async (client) => {
    const activeJobs = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM ingestion_jobs
       WHERE source_id = $1 AND metadata @> '{"kind":"entity_extraction"}'::jsonb
         AND status IN ('queued', 'processing')
       FOR UPDATE`,
      [sourceId],
    );
    if (activeJobs.rows.length > 0) {
      throw new Error(
        `Entity extraction already running for source ${sourceId} (job ${activeJobs.rows[0].id}: ${activeJobs.rows[0].status})`,
      );
    }

    return createIngestionJob({
      kind: "reprocess" as IngestionJobRecord["kind"],
      sourceId,
      requestedByUserId,
      metadata: { kind: "entity_extraction" },
      client,
    });
  });

  const queueId = await enqueueJob(job.id);
  return { job, queueId };
}

export async function runEntityExtraction(jobId: string): Promise<void> {
  await markJobProcessing(jobId);

  try {
    const jobResult = await query<{
      source_id: string | null;
      file_id: string | null;
    }>("SELECT source_id, file_id FROM ingestion_jobs WHERE id = $1", [jobId]);

    const job = jobResult.rows[0];
    if (!job?.source_id) {
      await markJobFailed(jobId, "Job missing source_id");
      return;
    }

    const files = await listSourceFiles(job.source_id);
    if (files.length === 0) {
      await markJobFailed(jobId, "No files found for source");
      return;
    }

    const allExtractedEntities: EntityInput[] = [];
    const allChunks = new Map<string, ExtractionChunk>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const progress = Math.round((i / files.length) * 50);
      await updateJobProgress(jobId, progress);

      const chunks = await loadChunksForFile(file.id);
      if (chunks.length === 0) continue;

      for (const c of chunks) allChunks.set(c.id, c);

      const entities = await identifyEntities(
        chunks,
        job.source_id,
        file.id,
      );

      allExtractedEntities.push(...entities);

      console.log(
        `[entity-extraction] File ${i + 1}/${files.length}: identified ${entities.length} entities`,
      );
    }

    await updateJobProgress(jobId, 50);

    const validatedEntities = await aiValidateEntities(allExtractedEntities);
    console.log(
      `[entity-extraction] Validation: ${allExtractedEntities.length} raw → ${validatedEntities.length} valid`,
    );

    await updateJobProgress(jobId, 55);

    const dedupedEntities = await aiDeduplicate(validatedEntities);
    console.log(
      `[entity-extraction] AI dedup: ${validatedEntities.length} → ${dedupedEntities.length} unique`,
    );

    await updateJobProgress(jobId, 60);

    const describedEntities = assembleDescriptions(dedupedEntities, allChunks);

    await updateJobProgress(jobId, 70);

    const formattedEntities = await aiFormatDescriptions(describedEntities);
    console.log(
      `[entity-extraction] Formatted ${formattedEntities.filter((e) => e.description.length > 0).length} descriptions`,
    );

    await updateJobProgress(jobId, 80);

    for (const file of files) {
      await deleteEntitiesForFile(file.id);
    }

    const inserted = await persistEntities(formattedEntities);

    await linkChildEntitiesToClasses(job.source_id);

    await query(
      "UPDATE ingestion_jobs SET entity_count = $2 WHERE id = $1",
      [jobId, inserted],
    );

    await markJobSucceeded(jobId);
    console.log(
      `[entity-extraction] Job ${jobId} completed: ${inserted} total entities`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[entity-extraction] Job ${jobId} failed:`, message);
    await markJobFailed(jobId, message);
  }
}

export async function reprocessEntityDescription(entityId: string): Promise<void> {
  const result = await query<{
    id: string;
    name: string;
    entity_type: string;
    chunk_ids: string[] | null;
    description: string;
  }>("SELECT id, name, entity_type, chunk_ids, description FROM entities WHERE id = $1", [entityId]);

  if (result.rows.length === 0) return;

  const row = result.rows[0];
  const chunkIds = row.chunk_ids ?? [];

  const chunks = await query<{ text: string; page_number: number | null }>(
    "SELECT text, page_number FROM chunks WHERE id = ANY($1) ORDER BY page_number",
    [chunkIds],
  );

  let description: string;
  if (chunks.rows.length > 0) {
    description = chunks.rows.map((c) => c.text).join("\n\n");
  } else if (row.description) {
    description = row.description;
  } else {
    return;
  }

  if (description.length < 50) return;

  try {
    const entityLike = { entityType: row.entity_type as EntityType, name: row.name, description } as EntityInput;
    const llmResult = await chatCompletion(
      [{
        role: "user",
        content: formatPromptForEntity(entityLike),
      }],
      { maxTokens: 4096, temperature: 0, preferOllamaNative: true },
    );
    const formatted = llmResult.content.trim();
    if (formatted.length > 20) {
      await query("UPDATE entities SET description = $1 WHERE id = $2", [formatted, entityId]);
    }
  } catch (err) {
    console.warn(`[reprocess] Format failed for "${row.name}":`, err instanceof Error ? err.message : err);
  }
}

async function aiValidateEntities(entities: readonly EntityInput[]): Promise<EntityInput[]> {
  if (entities.length === 0) return [];

  const batchSize = 15;
  const validIndices = new Set<number>();

  for (let start = 0; start < entities.length; start += batchSize) {
    const batch = entities.slice(start, start + batchSize);
    const list = batch.map((e, i) => `${start + i}: ${e.name} (${e.entityType})`).join("\n");

    const prompt = `You are a D&D content validator for a Russian-language homebrew rulebook. Validate each entity below.

REJECT if ANY of these apply:
- Name is in English or transliterated English (e.g. "Action Surge", "Акшен Сёрдж", "Eldritch Knight", "Сник Атак", "Сейдж")
- Name is a setting/campaign world name (e.g. "Вороний трон" as a book title)
- Name is a region, place, or geographical area (e.g. "Трисвечье", "Долина Озёр", "Готнорд")
- Name is a pantheon or religion without mechanical rules (e.g. "Светлый пантеон", "Шестибожие")
- Name is a game system name, section header, lone adjective, or PDF artifact
- Entity type is clearly wrong (e.g. a region classified as species, a place classified as class)
- Gibberish, truncated, or nonsensical names

ACCEPT: classes, subclasses, species/races, spells, feats, class features, monsters, magic items, backgrounds, and distinct game mechanics with actual rules content.

Output ONLY a JSON array of indices to KEEP. No explanation.

Entities:
${list}

Indices to keep:`;

    try {
      const llmResult = await chatCompletion(
        [{ role: "user", content: prompt }],
        { maxTokens: 1024, temperature: 0, preferOllamaNative: true },
      );
      const match = llmResult.content.match(/\[[\s\S]*\]/);
      if (match) {
        const indices: number[] = JSON.parse(match[0]);
        for (const idx of indices) {
          if (typeof idx === "number" && idx >= start && idx < start + batch.length) {
            validIndices.add(idx);
          }
        }
      }
    } catch (err) {
      console.warn("[entity-extraction] Validation failed, keeping all:", err instanceof Error ? err.message : err);
      for (let i = start; i < start + batch.length; i++) validIndices.add(i);
    }
  }

  const result = entities.filter((_, i) => validIndices.has(i));
  const removed = entities.length - result.length;
  if (removed > 0) {
    const removedNames = entities
      .filter((_, i) => !validIndices.has(i))
      .map((e) => `"${e.name}"`)
      .join(", ");
    console.log(`[entity-extraction] Validation removed ${removed}: ${removedNames}`);
  }
  return result;
}

function mergeGroup(members: EntityInput[]): EntityInput {
  const chunkIds = new Set<string>();
  const pageNumbers = new Set<number>();
  const names: string[] = [];
  const attrs = { ...(members[0].attributes as Record<string, unknown>) };

  for (const entity of members) {
    for (const id of entity.chunkIds) chunkIds.add(id);
    for (const p of entity.pageNumbers) pageNumbers.add(p);
    if (!names.includes(entity.name)) names.push(entity.name);
    const srcAttrs = entity.attributes as Record<string, unknown>;
    for (const [k, v] of Object.entries(srcAttrs)) {
      if (Array.isArray(v) && v.length > 0) {
        const existing = attrs[k];
        if (Array.isArray(existing)) {
          attrs[k] = [...new Set([...existing, ...v])];
        } else if (!existing) {
          attrs[k] = v;
        }
      } else if (v !== undefined && v !== null && v !== "" &&
        (attrs[k] === undefined || attrs[k] === null || attrs[k] === "")) {
        attrs[k] = v;
      }
    }
  }

  const bestName = names.reduce((a, b) => (a.length <= b.length ? a : b));

  return {
    ...members[0],
    name: bestName,
    description: "",
    attributes: attrs,
    pageNumbers: Array.from(pageNumbers).sort((a, b) => a - b),
    chunkIds: Array.from(chunkIds),
  };
}

function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s\-_]+/g, " ")
    .replace(/[()\"']/g, "");
}

const RU_PLURAL_SUFFIXES = [
  ["цы", "ц"],
  ["цы", "ец"],
  ["и", "а"],
  ["ы", "а"],
  ["и", "й"],
  ["и", "ь"],
  ["ы", ""],
  ["и", ""],
  ["е", "й"],
  ["та", "т"],
  ["не", "н"],
];

function isStemMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  for (const [plural, singular] of RU_PLURAL_SUFFIXES) {
    if (longer.endsWith(plural) && shorter.endsWith(singular)) {
      const longerStem = longer.slice(0, -plural.length);
      const shorterStem = shorter.slice(0, -singular.length);
      if (longerStem === shorterStem) return true;
    }
  }
  return false;
}

function namesCouldMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 2 || b.length < 2) return false;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (shorter.length / longer.length < 0.4) return false;

  if (a.includes(b) || b.includes(a)) return true;

  const commonPrefixLen = (() => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  })();
  if (commonPrefixLen / longer.length >= 0.5) return true;

  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const c of setA) if (setB.has(c)) shared++;
  if (shared / Math.max(setA.size, setB.size) < 0.4) return false;

  return true;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
  groups(n: number): number[][] {
    const map = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = this.find(i);
      if (!map.has(root)) map.set(root, []);
      map.get(root)!.push(i);
    }
    return [...map.values()];
  }
}

async function aiDeduplicate(entities: readonly EntityInput[]): Promise<EntityInput[]> {
  if (entities.length <= 1) return [...entities];

  const byType = new Map<string, EntityInput[]>();
  for (const e of entities) {
    const key = e.entityType;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(e);
  }

  const result: EntityInput[] = [];

  for (const [type, group] of byType) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const uf = new UnionFind(group.length);

    const MAX_GROUP_SIZE = 50;
    if (group.length > MAX_GROUP_SIZE) {
      console.warn(`[dedup] Type "${type}" has ${group.length} entities, capping pairwise comparison to first ${MAX_GROUP_SIZE}`);
    }

    const normToIndices = new Map<string, number[]>();
    for (let i = 0; i < group.length; i++) {
      const n = normalize(group[i].name);
      if (!normToIndices.has(n)) normToIndices.set(n, []);
      normToIndices.get(n)!.push(i);
    }
    for (const indices of normToIndices.values()) {
      for (let i = 1; i < indices.length; i++) {
        uf.union(indices[0], indices[i]);
      }
    }

    const limit = Math.min(group.length, MAX_GROUP_SIZE);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        if (uf.find(i) === uf.find(j)) continue;

        const ni = normalize(group[i].name);
        const nj = normalize(group[j].name);

        if (isStemMatch(ni, nj)) {
          uf.union(i, j);
          console.log(`[dedup] Stem merged: "${group[i].name}" = "${group[j].name}"`);
          continue;
        }

        if (!namesCouldMatch(ni, nj)) continue;

        const prompt = `Are these two ${type} names the EXACT SAME entity? Answer ONLY "yes" or "no".

A: "${group[i].name}"
B: "${group[j].name}"

"yes" ONLY for obvious duplicates (singular/plural, abbreviation, typo). When in doubt, answer "no".
Answer:`;

        try {
          const llmResult = await chatCompletion(
            [{ role: "user", content: prompt }],
            { maxTokens: 16, temperature: 0, preferOllamaNative: true },
          );
          const answer = llmResult.content.trim().toLowerCase();
          if (answer.startsWith("yes")) {
            uf.union(i, j);
            console.log(`[dedup] Merged: "${group[i].name}" = "${group[j].name}"`);
          }
        } catch {
          console.warn(`[dedup] Compare failed: "${group[i].name}" vs "${group[j].name}"`);
        }
      }
    }

    for (const idxGroup of uf.groups(group.length)) {
      result.push(mergeGroup(idxGroup.map((i) => group[i])));
    }
  }

  const seen = new Map<string, EntityInput>();
  const finalResult: EntityInput[] = [];
  for (const entity of result) {
    const key = normalize(entity.name);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, entity);
      finalResult.push(entity);
      continue;
    }
    const winner = pickTypeWinner(existing, entity);
    if (winner === entity) {
      const idx = finalResult.findIndex((e) => e === existing);
      if (idx !== -1) finalResult[idx] = entity;
      seen.set(key, entity);
    }
  }

  return finalResult;
}

function pickTypeWinner(a: EntityInput, b: EntityInput): EntityInput {
  return (a.chunkIds.length >= b.chunkIds.length) ? a : b;
}

const FORMAT_PROMPT_BASE = `You are a D&D content formatter. Given raw text from a rulebook page, extract and format ONLY the information about the specified entity that appears IN THE TEXT.

CRITICAL RULES:
- You MUST NOT add, invent, infer, or hallucinate ANY information. Only reformat what is explicitly written.
- If the text does not mention something about the entity, do NOT include it.
- Extract ONLY content directly about the named entity — ignore sections about other entities.

Formatting:
- Use **bold** for important terms and keywords
- Use *italic* for emphasis
- Use ## and ### for sections
- Use bullet points for lists
- Keep the original language
- Fix broken lines from PDF extraction`;

const FORMAT_PROMPT_CLASS = `\n- Do NOT mention any class features, abilities, or subclass details — those exist as separate entities. Only include class overview, role, and general description.`;

function formatPromptForEntity(entity: EntityInput): string {
  let prompt = FORMAT_PROMPT_BASE;
  if (entity.entityType === "class") prompt += FORMAT_PROMPT_CLASS;
  return `${prompt}\n\nEntity: "${entity.name}" (type: ${entity.entityType})\n\nRaw text from rulebook:\n${entity.description}`;
}

async function linkChildEntitiesToClasses(sourceId: string): Promise<void> {
  const classResult = await query<{ id: string; name: string }>(
    "SELECT id, name FROM entities WHERE entity_type IN ('class', 'species') AND source_id = $1",
    [sourceId],
  );

  if (classResult.rows.length === 0) return;

  const classNames = new Map<string, string>();
  const classNamesNorm = new Map<string, string>();
  for (const row of classResult.rows) {
    classNames.set(row.name.trim().toLowerCase(), row.id);
    classNamesNorm.set(normalize(row.name), row.id);
  }

  const childResult = await query<{ id: string; attributes: Record<string, unknown> }>(
    `SELECT id, attributes FROM entities
     WHERE entity_type IN ('class_feature', 'subclass')
       AND source_id = $1
       AND parent_entity_id IS NULL`,
    [sourceId],
  );

  const links: Map<string, string[]> = new Map();

  for (const child of childResult.rows) {
    const rawClass = String(child.attributes?.class ?? "").trim();
    const className = rawClass.toLowerCase();
    const classNorm = normalize(rawClass);

    let parentId = classNames.get(className);

    if (!parentId) {
      for (const [normName, id] of classNamesNorm) {
        const tokens = classNorm.split(/\s+/);
        if (tokens.some((t) => t === normName) || normName.split(/\s+/).some((t) => t === classNorm)) {
          parentId = id;
          break;
        }
      }
    }

    if (!parentId) {
      for (const [normName, id] of classNamesNorm) {
        if (isStemMatch(classNorm, normName)) {
          parentId = id;
          break;
        }
      }
    }

    if (parentId) {
      if (!links.has(parentId)) links.set(parentId, []);
      links.get(parentId)!.push(child.id);
    }
  }

  let totalLinked = 0;
  for (const [parentId, childIds] of links) {
    await linkChildEntities(parentId, childIds);
    totalLinked += childIds.length;
  }

  console.log(
    `[entity-extraction] Linked ${totalLinked} child entities to ${classResult.rows.length} classes`,
  );
}

function assembleDescriptions(
  entities: readonly EntityInput[],
  chunkMap: Map<string, ExtractionChunk>,
): EntityInput[] {
  return entities.map((entity) => {
    const entityChunks = entity.chunkIds
      .map((id) => chunkMap.get(id))
      .filter((c): c is ExtractionChunk => c !== undefined);

    if (entityChunks.length === 0) return entity;

    const description = [...entityChunks]
      .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
      .map((c) => c.text)
      .join("\n\n");

    return { ...entity, description };
  });
}

async function aiFormatDescriptions(
  entities: readonly EntityInput[],
): Promise<EntityInput[]> {
  const toFormat = entities
    .map((e, i) => ({ entity: e, index: i }))
    .filter(({ entity }) => entity.description && entity.description.length >= 200);

  if (toFormat.length === 0) return [...entities];

  const formatted = new Map<number, string>();
  const concurrency = 3;
  let next = 0;

  async function formatNext(): Promise<void> {
    while (next < toFormat.length) {
      const item = toFormat[next++];
      const { entity, index } = item;

      try {
        const llmResult = await chatCompletion(
          [{
            role: "user",
            content: formatPromptForEntity(entity),
          }],
          { maxTokens: 4096, temperature: 0, preferOllamaNative: true },
        );
        const text = llmResult.content.trim();
        formatted.set(index, text.length > 20 ? text : entity.description);
      } catch (err) {
        console.warn(
          `[entity-extraction] Format failed for "${entity.name}":`,
          err instanceof Error ? err.message : err,
        );
      }

      console.log(
        `[entity-extraction] Formatted "${entity.name}" (${formatted.size}/${toFormat.length})`,
      );
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => formatNext()));

  return entities.map((entity, i) => {
    const f = formatted.get(i);
    return f ? { ...entity, description: f } : entity;
  });
}
