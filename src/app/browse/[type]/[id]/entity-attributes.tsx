"use client";

import type { EntityAttributes as EntityAttributesType, EntityType } from "../../../../server/entities/types";

export function EntityAttributes({
  entityType,
  attributes,
}: {
  entityType: EntityType;
  attributes: EntityAttributesType;
}) {
  const attrs = attributes as Record<string, unknown>;
  const entries = Object.entries(attrs).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );

  if (entries.length === 0) return null;

  const labelMap: Record<string, string> = {
    level: "Level",
    school: "School",
    casting_time: "Casting Time",
    range: "Range",
    components: "Components",
    duration: "Duration",
    classes: "Classes",
    ac: "AC",
    hp: "HP",
    speed: "Speed",
    str: "STR",
    dex: "DEX",
    con: "CON",
    int: "INT",
    wis: "WIS",
    cha: "CHA",
    cr: "CR",
    type: "Type",
    size: "Size",
    alignment: "Alignment",
    class: "Class",
    subclass: "Subclass",
    prerequisite: "Prerequisite",
    rarity: "Rarity",
    attunement: "Attunement",
    traits: "Traits",
    skill_proficiencies: "Skill Proficiencies",
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 text-lg font-bold text-text-primary">Attributes</h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              {labelMap[key] ?? key}
            </dt>
            <dd className="mt-0.5 text-sm text-text-secondary">
              {formatAttributeValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatAttributeValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
