import { chatCompletion, type ChatMessage } from "../../server/llm/client.ts";
import { isEntityType, type EntityInput, type EntityType } from "../../server/entities/types.ts";
import { normalizeEntityName, namesCouldMatch } from "../../server/entities/name-utils.ts";
import { mergeEntityGroup } from "../../server/entities/merge-utils.ts";

const BATCH_SIZE = 5;

const EXTRACTION_USER_PROMPT = `Extract D&D entities from the text below as a JSON array.

Entity types and rules:
- "class": a playable class with levels, hit die, features (e.g. Fighter, Wizard, Колдун)
- "subclass": a specialization of a class. ALWAYS include "class" in attributes with the parent class name (e.g. {"class":"Колдун"})
- "class_feature": a specific ability gained by a class at a level. ALWAYS include "class" in attributes with the parent class name (e.g. {"class":"Колдун","level":3})
- "species": a playable race/species (e.g. Elf, Human, Стидиец, Крыслинг)
- "feat": an optional ability chosen at level-up (NOT class features)
- "spell": a spell with casting rules (e.g. Fireball, Wish)
- "monster": a creature/NPC with stat block or bestiary entry
- "magic_item": a magical weapon, armor, potion, or artifact
- "background": a character background (e.g. Soldier, Sage)
- "other": game mechanics that don't fit above (e.g. a unique subsystem)

Do NOT extract:
- Game system names (D&D, Dungeons & Dragons)
- Region/place names (use "other" only if it's a game mechanic)
- Deity names unless they have mechanical rules attached
- Adjectives, descriptors, or title words by themselves
- Table headers, section titles, or formatting artifacts

Each entity must have:
- "type": the entity type string from above
- "name": entity name in original language (2+ characters, must be a proper noun or specific term)
- "attributes": simple key-value details only (e.g. {"level":1, "hit_die":"d8", "class":"Колдун", "speed":"30 футов"}). Do NOT nest objects or arrays inside attributes — each distinct ability/feature must be a SEPARATE entity with its own type "class_feature".
- "chunk_ids": array of chunk IDs mentioning this entity
- "page_numbers": array of page numbers

Output ONLY a valid JSON array. No other text. If no valid entities found, output [].

Text:`;

type RawExtractedEntity = {
  type?: string;
  name?: string;
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

  return parsed
    .filter((item): item is RawExtractedEntity => {
      if (typeof item !== "object" || item === null) return false;
      return typeof item.name === "string" && item.name.trim().length > 0
        && typeof item.type === "string" && isEntityType(item.type);
    })
    .map((item) => ({
      fileId,
      sourceId,
      entityType: item.type as EntityType,
      name: item.name!.trim(),
      description: "",
      attributes: (item.attributes ?? {}) as EntityInput["attributes"],
      pageNumbers: Array.isArray(item.page_numbers)
        ? item.page_numbers.filter((p): p is number => typeof p === "number")
        : [],
      chunkIds: Array.isArray(item.chunk_ids)
        ? item.chunk_ids.filter((c): c is string => typeof c === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c))
        : [],
    }));
}

function mergeExtractedDuplicates(entities: readonly EntityInput[]): EntityInput[] {
  const groups: { key: string; names: string[]; entities: EntityInput[] }[] = [];

  for (const entity of entities) {
    const norm = normalizeEntityName(entity.name);
    let matchedGroup = groups.find(
      (g) => g.entities[0].entityType === entity.entityType &&
        g.names.some((n) => namesCouldMatch(norm, n)),
    );

    if (!matchedGroup) {
      matchedGroup = { key: `${entity.entityType}:${norm}`, names: [norm], entities: [] };
      groups.push(matchedGroup);
    }
    if (!matchedGroup.names.includes(norm)) matchedGroup.names.push(norm);
    matchedGroup.entities.push(entity);
  }

  return groups.map((data) => mergeEntityGroup(data.entities));
}

export type ExtractionChunk = Readonly<{
  id: string;
  text: string;
  pageNumber: number | null;
}>;

export async function identifyEntities(
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
      {
        role: "user",
        content: `${EXTRACTION_USER_PROMPT}\n\n${batchText}`,
      },
    ];

    let content: string;
    let entities: EntityInput[] = [];
    const maxRetries = 2;

    for (let retry = 0; retry <= maxRetries; retry++) {
      try {
        const result = await chatCompletion(messages, {
          maxTokens: 4096,
          temperature: 0,
          preferOllamaNative: true,
        });
        content = result.content;
      } catch (err) {
        console.error(
          `[entity-extract] Pass 1 LLM call failed for batch ${i / BATCH_SIZE + 1}:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }

      entities = parseEntityResponse(content, sourceId, fileId);
      if (entities.length > 0) break;

      if (retry < maxRetries) {
        console.warn(
          `[entity-extract] Batch ${i / BATCH_SIZE + 1} returned 0 entities (attempt ${retry + 1}), retrying...`,
        );
      }
    }

    allEntities.push(...entities);

    console.log(
      `[entity-extract] Pass 1 batch ${i / BATCH_SIZE + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}: identified ${entities.length} entities`,
    );
  }

  return mergeExtractedDuplicates(allEntities);
}
