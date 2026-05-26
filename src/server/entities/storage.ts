import { query } from "../db/client.ts";
import type { EntityRecord, EntityInput, EntityType } from "./types.ts";

export async function persistEntities(
  entities: readonly EntityInput[],
): Promise<number> {
  if (entities.length === 0) return 0;

  const BATCH_SIZE = 25;
  let totalInserted = 0;

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);
    const valueGroups: string[] = [];
    const params: unknown[] = [];

    for (let j = 0; j < batch.length; j++) {
      const entity = batch[j];
      const base = j * 8;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::integer[], $${base + 8}::uuid[])`,
      );
      params.push(
        entity.fileId,
        entity.sourceId,
        entity.entityType,
        entity.name,
        entity.description,
        JSON.stringify(entity.attributes),
        entity.pageNumbers.length > 0 ? entity.pageNumbers : null,
        entity.chunkIds.length > 0 ? entity.chunkIds : null,
      );
    }

    const sql = `INSERT INTO entities (
        file_id, source_id, entity_type, name, description,
        attributes, page_numbers, chunk_ids
      ) VALUES ${valueGroups.join(", ")}`;

    await query(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
}

export async function deleteEntitiesForFile(fileId: string): Promise<number> {
  const result = await query(
    "DELETE FROM entities WHERE file_id = $1",
    [fileId],
  );
  return result.rowCount ?? 0;
}

export async function countEntitiesByType(
  sourceIds?: readonly string[],
): Promise<Record<EntityType, number>> {
  const counts = {} as Record<EntityType, number>;
  for (const type of [
    "spell", "feat", "class_feature", "monster", "magic_item",
    "species", "subclass", "background", "other",
  ]) {
    counts[type as EntityType] = 0;
  }

  let sql = "SELECT entity_type, COUNT(*)::text AS count FROM entities";
  const values: unknown[] = [];
  if (sourceIds && sourceIds.length > 0) {
    sql += " WHERE source_id = ANY($1)";
    values.push(sourceIds);
  }
  sql += " GROUP BY entity_type";

  const result = await query<{ entity_type: EntityType; count: string }>(sql, values);
  for (const row of result.rows) {
    counts[row.entity_type] = parseInt(row.count, 10);
  }
  return counts;
}

export type EntityListResult = Readonly<{
  items: readonly EntityRecord[];
  total: number;
  page: number;
  pageSize: number;
}>;

type EntityRow = Readonly<{
  id: string;
  file_id: string;
  source_id: string;
  entity_type: EntityType;
  name: string;
  description: string;
  attributes: EntityRecord["attributes"];
  page_numbers: number[] | null;
  chunk_ids: string[] | null;
  created_at: string;
}>;

function rowToRecord(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    fileId: row.file_id,
    sourceId: row.source_id,
    entityType: row.entity_type,
    name: row.name,
    description: row.description,
    attributes: row.attributes,
    pageNumbers: row.page_numbers ?? [],
    chunkIds: row.chunk_ids ?? [],
    createdAt: row.created_at,
  };
}

export async function listEntitiesByType(
  entityType: EntityType,
  options?: {
    filters?: Record<string, string>;
    page?: number;
    pageSize?: number;
    sourceIds?: readonly string[];
  },
): Promise<EntityListResult> {
  const page = Math.max(1, options?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options?.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ["e.entity_type = $1"];
  const values: unknown[] = [entityType];
  let paramIdx = 2;

  if (options?.sourceIds && options.sourceIds.length > 0) {
    conditions.push(`e.source_id = ANY($${paramIdx++})`);
    values.push(options.sourceIds);
  }

  if (options?.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      if (!value) continue;
      if (key === "level") {
        conditions.push(`(e.attributes->>'level')::integer = $${paramIdx++}`);
        values.push(parseInt(value, 10));
      } else if (key === "school") {
        conditions.push(`e.attributes->>'school' = $${paramIdx++}`);
        values.push(value);
      } else if (key === "cr") {
        conditions.push(`e.attributes->>'cr' = $${paramIdx++}`);
        values.push(value);
      } else if (key === "type") {
        conditions.push(`e.attributes->>'type' = $${paramIdx++}`);
        values.push(value);
      } else if (key === "rarity") {
        conditions.push(`e.attributes->>'rarity' = $${paramIdx++}`);
        values.push(value);
      }
    }
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM entities e ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataValues = [...values, pageSize, offset];
  const dataResult = await query<EntityRow>(
    `SELECT e.* FROM entities e ${where} ORDER BY e.name LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    dataValues,
  );

  return {
    items: dataResult.rows.map(rowToRecord),
    total,
    page,
    pageSize,
  };
}

export async function getEntityById(
  id: string,
): Promise<(EntityRecord & { sourceTitle: string }) | null> {
  const result = await query<
    EntityRow & { source_title: string }
  >(
    `SELECT e.*, s.title AS source_title
     FROM entities e
     JOIN sources s ON s.id = e.source_id
     WHERE e.id = $1`,
    [id],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    ...rowToRecord(row),
    sourceTitle: row.source_title,
  };
}

export async function listSourceFiles(
  sourceId: string,
): Promise<readonly { id: string; storagePath: string }[]> {
  const result = await query<{ id: string; storage_path: string }>(
    "SELECT id, storage_path FROM files WHERE source_id = $1 AND deleted_at IS NULL",
    [sourceId],
  );
  return result.rows.map((r) => ({ id: r.id, storagePath: r.storage_path }));
}

export async function loadChunksForFile(
  fileId: string,
): Promise<
  readonly {
    id: string;
    text: string;
    pageNumber: number | null;
  }[]
> {
  const result = await query<
    { id: string; text: string; page_number: number | null }
  >(
    "SELECT id, text, page_number FROM chunks WHERE file_id = $1 ORDER BY chunk_index",
    [fileId],
  );
  return result.rows.map((r) => ({ id: r.id, text: r.text, pageNumber: r.page_number }));
}
