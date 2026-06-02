import { query, withTransaction, type PoolClient } from "../db/client.ts";
import type { EntityRecord, EntityInput, EntityType } from "./types.ts";

export async function persistEntities(
  entities: readonly EntityInput[],
  client?: PoolClient,
): Promise<number> {
  if (entities.length === 0) return 0;

  const BATCH_SIZE = 25;
  let totalInserted = 0;
  const exec = client ? (sql: string, params: unknown[]) => client.query(sql, params) : query;

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);
    const valueGroups: string[] = [];
    const params: unknown[] = [];

    for (let j = 0; j < batch.length; j++) {
      const entity = batch[j];
      const base = j * 9;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}::integer[], $${base + 8}::uuid[], $${base + 9}::uuid)`,
      );
      params.push(
        entity.fileId,
        entity.sourceId,
        entity.entityType,
        entity.name,
        entity.description,
        JSON.stringify(entity.attributes),
        entity.pageNumbers,
        entity.chunkIds,
        entity.parentEntityId ?? null,
      );
    }

    const sql = `INSERT INTO entities (
        file_id, source_id, entity_type, name, description,
        attributes, page_numbers, chunk_ids, parent_entity_id
      ) VALUES ${valueGroups.join(", ")}`;

    await exec(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
}

export async function deleteEntitiesForFile(fileId: string, client?: PoolClient): Promise<number> {
  const exec = client ? (sql: string, params: unknown[]) => client.query(sql, params) : query;
  const result = await exec(
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
    "spell", "feat", "class_feature", "class", "monster", "magic_item",
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
  parent_entity_id: string | null;
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
    parentEntityId: row.parent_entity_id,
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
      } else if (key === "primary_ability") {
        conditions.push(`e.attributes->'primary_ability' ? $${paramIdx++}`);
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

export async function listChildrenOf(
  parentId: string,
  entityType?: EntityType,
): Promise<readonly EntityRecord[]> {
  const conditions = ["e.parent_entity_id = $1"];
  const values: unknown[] = [parentId];

  if (entityType) {
    conditions.push("e.entity_type = $2");
    values.push(entityType);
  }

  const result = await query<EntityRow>(
    `SELECT e.* FROM entities e WHERE ${conditions.join(" AND ")} ORDER BY e.name`,
    values,
  );
  return result.rows.map(rowToRecord);
}

export async function linkChildEntities(
  parentId: string,
  childIds: readonly string[],
): Promise<number> {
  if (childIds.length === 0) return 0;
  const result = await query(
    "UPDATE entities SET parent_entity_id = $1 WHERE id = ANY($2)",
    [parentId, childIds],
  );
  return result.rowCount ?? 0;
}

export async function mergeEntities(
  targetId: string,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return;

  await withTransaction(async (client) => {
    const allIds = [targetId, ...sourceIds];
    const result = await client.query<EntityRow>(
      "SELECT * FROM entities WHERE id = ANY($1) ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END",
      [allIds, targetId],
    );

    if (result.rows.length === 0) return;

    const target = rowToRecord(result.rows[0]);
    const sources = result.rows.slice(1).map(rowToRecord);

    const mergedChunkIds = new Set<string>(target.chunkIds);
    const mergedPageNumbers = new Set<number>(target.pageNumbers);
    const descriptions = [target.description];
    const mergedAttributes = { ...target.attributes } as Record<string, unknown>;

    for (const src of sources) {
      for (const id of src.chunkIds) mergedChunkIds.add(id);
      for (const p of src.pageNumbers) mergedPageNumbers.add(p);
      if (src.description && src.description !== target.description) {
        descriptions.push(src.description);
      }
      const srcAttrs = src.attributes as Record<string, unknown>;
      for (const [k, v] of Object.entries(srcAttrs)) {
        if (Array.isArray(v) && v.length > 0) {
          const existing = mergedAttributes[k];
          if (Array.isArray(existing)) {
            mergedAttributes[k] = [...new Set([...existing, ...v])];
          } else if (existing === undefined || existing === null || existing === "") {
            mergedAttributes[k] = v;
          }
        } else if (v !== undefined && v !== null && v !== "" &&
          (mergedAttributes[k] === undefined || mergedAttributes[k] === null || mergedAttributes[k] === "")) {
          mergedAttributes[k] = v;
        }
      }
    }

    await client.query(
      `UPDATE entities SET
        description = $1,
        attributes = $2::jsonb,
        page_numbers = $3::integer[],
        chunk_ids = $4::uuid[]
       WHERE id = $5`,
      [
        descriptions.filter(Boolean).join("\n\n"),
        JSON.stringify(mergedAttributes),
        Array.from(mergedPageNumbers).sort((a, b) => a - b),
        Array.from(mergedChunkIds),
        targetId,
      ],
    );

    await client.query(
      "UPDATE entities SET parent_entity_id = $1 WHERE parent_entity_id = ANY($2)",
      [targetId, sourceIds],
    );

    await client.query(
      "DELETE FROM entities WHERE id = ANY($1)",
      [sourceIds],
    );
  });
}

export async function listEntitiesForMerge(
  entityType: EntityType,
  sourceIds?: readonly string[],
): Promise<readonly EntityRecord[]> {
  const conditions = ["e.entity_type = $1"];
  const values: unknown[] = [entityType];

  if (sourceIds && sourceIds.length > 0) {
    conditions.push("e.source_id = ANY($2)");
    values.push(sourceIds);
  }

  const result = await query<EntityRow>(
    `SELECT e.* FROM entities e WHERE ${conditions.join(" AND ")} ORDER BY e.name LIMIT 500`,
    values,
  );
  return result.rows.map(rowToRecord);
}
