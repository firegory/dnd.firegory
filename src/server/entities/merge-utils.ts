import type { EntityInput } from "./types.ts";

export function mergeEntityGroup(members: EntityInput[]): EntityInput {
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
