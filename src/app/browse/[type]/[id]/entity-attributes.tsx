"use client";

import type { EntityAttributes as EntityAttributesType, EntityType } from "../../../../server/entities/types";
import { useUiLanguage, type TranslationKey } from "../../../../components/ui/i18n";

export function EntityAttributes({
  attributes,
}: {
  entityType: EntityType;
  attributes: EntityAttributesType;
}) {
  const { t } = useUiLanguage();
  const attrs = attributes as Record<string, unknown>;
  const entries = Object.entries(attrs).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );

  if (entries.length === 0) return null;

  const labelMap: Record<string, TranslationKey> = {
    level: "filterLevel",
    school: "filterSchool",
    casting_time: "castingTime",
    range: "range",
    components: "components",
    duration: "duration",
    classes: "entityTypeClass",
    ac: "ac",
    hp: "hp",
    speed: "speed",
    str: "str",
    dex: "dex",
    con: "con",
    int: "int",
    wis: "wis",
    cha: "cha",
    cr: "filterCr",
    type: "type",
    size: "size",
    alignment: "alignment",
    class: "entityTypeClass",
    subclass: "entityTypeSubclass",
    prerequisite: "prerequisite",
    rarity: "filterRarity",
    attunement: "attunement",
    traits: "traits",
    skill_proficiencies: "skillProficiencies",
    levels: "levels",
    hit_die: "hitDie",
    primary_ability: "primaryAbility",
    saving_throws: "savingThrows",
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 text-lg font-bold text-text-primary">{t("attributes")}</h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              {labelMap[key] ? t(labelMap[key]) : key}
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
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v))).join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
