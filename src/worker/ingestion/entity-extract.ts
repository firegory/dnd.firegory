import { chatCompletion, type ChatMessage } from "../../server/llm/zai.ts";
import type { EntityInput, EntityType } from "../../server/entities/types.ts";

const BATCH_SIZE = 15;

const SYSTEM_PROMPT = `You are a D&D 5e entity extractor. Given text from a rulebook, extract all named entities (spells, monsters, feats, class features, magic items, species/races, subclasses, backgrounds).

For each entity, output a JSON object with:
- "type": one of "spell", "feat", "class_feature", "monster", "magic_item", "species", "subclass", "background", "other"
- "name": the entity's name
- "description": brief description (1-3 sentences from the text)
- "attributes": type-specific details as JSON:
  - spells: {"level": number, "school": string, "casting_time": string, "range": string, "components": string, "duration": string, "classes": [string]}
  - monsters: {"ac": number, "hp": string, "cr": string, "type": string, "size": string, "str": number, "dex": number, "con": number, "int": number, "wis": number, "cha": number}
  - class features: {"class": string, "subclass": string, "level": number}
  - feats: {"prerequisite": string}
  - magic items: {"rarity": string, "attunement": boolean, "type": string}
  - species: {"traits": [string]}
  - subclasses: {"class": string, "level": number}
  - backgrounds: {"skill_proficiencies": [string]}
- "chunk_ids": array of chunk IDs that mention this entity
- "page_numbers": array of page numbers

Output ONLY a JSON array of entity objects. If no entities are found, output [].

Keep the text in its original language — do NOT translate.`;

type RawExtractedEntity = {
  type?: string;
  name?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  chunk_ids?: string[];
  page_numbers?: number[];
};

function parseEntityResponse(
  content: string,
  sourceId: string,
  fileId: string,
): EntityInput[] {
  let parsed: unknown;
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const validTypes = new Set<string>([
    "spell", "feat", "class_feature", "monster", "magic_item",
    "species", "subclass", "background", "other",
  ]);

  return parsed
    .filter((item): item is RawExtractedEntity => {
      if (typeof item !== "object" || item === null) return false;
      return typeof item.name === "string" && item.name.trim().length > 0
        && typeof item.type === "string" && validTypes.has(item.type);
    })
    .map((item) => ({
      fileId,
      sourceId,
      entityType: item.type as EntityType,
      name: item.name!.trim(),
      description: typeof item.description === "string" ? item.description : "",
      attributes: (item.attributes ?? {}) as EntityInput["attributes"],
      pageNumbers: Array.isArray(item.page_numbers)
        ? item.page_numbers.filter((p): p is number => typeof p === "number")
        : [],
      chunkIds: Array.isArray(item.chunk_ids)
        ? item.chunk_ids.filter((c): c is string => typeof c === "string")
        : [],
    }));
}

export type ExtractionChunk = Readonly<{
  id: string;
  text: string;
  pageNumber: number | null;
}>;

export async function extractEntities(
  chunks: readonly ExtractionChunk[],
  sourceId: string,
  fileId: string,
): Promise<EntityInput[]> {
  if (chunks.length === 0) return [];

  const allEntities: EntityInput[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const batchText = batch
      .map((c) => `[chunk_id: ${c.id}, page: ${c.pageNumber ?? "unknown"}]\n${c.text}`)
      .join("\n\n---\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Extract all D&D entities from the following text chunks:\n\n${batchText}`,
      },
    ];

    let content: string;
    try {
      const result = await chatCompletion(messages, {
        maxTokens: 4096,
        temperature: 0.2,
      });
      content = result.content;
    } catch (err) {
      console.error(
        `[entity-extract] LLM call failed for batch ${i / BATCH_SIZE + 1}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    const entities = parseEntityResponse(content, sourceId, fileId);
    allEntities.push(...entities);

    console.log(
      `[entity-extract] Batch ${i / BATCH_SIZE + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}: extracted ${entities.length} entities`,
    );
  }

  return allEntities;
}
