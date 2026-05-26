export type EntityType =
  | "spell"
  | "feat"
  | "class_feature"
  | "monster"
  | "magic_item"
  | "species"
  | "subclass"
  | "background"
  | "other";

export const ENTITY_TYPES: readonly EntityType[] = [
  "spell",
  "feat",
  "class_feature",
  "monster",
  "magic_item",
  "species",
  "subclass",
  "background",
  "other",
];

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

export type SpellAttributes = {
  level?: number;
  school?: string;
  casting_time?: string;
  range?: string;
  components?: string;
  duration?: string;
  classes?: string[];
};

export type MonsterAttributes = {
  ac?: number;
  hp?: string;
  speed?: string;
  str?: number;
  dex?: number;
  con?: number;
  int?: number;
  wis?: number;
  cha?: number;
  cr?: string;
  type?: string;
  size?: string;
  alignment?: string;
};

export type ClassFeatureAttributes = {
  class?: string;
  subclass?: string;
  level?: number;
};

export type FeatAttributes = {
  prerequisite?: string;
};

export type MagicItemAttributes = {
  rarity?: string;
  attunement?: boolean;
  type?: string;
};

export type SpeciesAttributes = {
  traits?: string[];
};

export type SubclassAttributes = {
  class?: string;
  level?: number;
};

export type BackgroundAttributes = {
  skill_proficiencies?: string[];
};

export type EntityAttributes =
  | SpellAttributes
  | MonsterAttributes
  | ClassFeatureAttributes
  | FeatAttributes
  | MagicItemAttributes
  | SpeciesAttributes
  | SubclassAttributes
  | BackgroundAttributes
  | Record<string, unknown>;

export type EntityFilterDef = Readonly<{
  key: string;
  labelKey: string;
  type: "select" | "range";
  options?: readonly { value: string; labelKey: string }[];
}>;

export type EntityTypeConfig = Readonly<{
  slug: string;
  labelKey: string;
  filters: readonly EntityFilterDef[];
}>;

export const ENTITY_CONFIG: Record<EntityType, EntityTypeConfig> = {
  spell: {
    slug: "spell",
    labelKey: "entityTypeSpell",
    filters: [
      {
        key: "level",
        labelKey: "filterLevel",
        type: "select",
        options: [
          { value: "", labelKey: "filterAny" },
          { value: "0", labelKey: "cantrip" },
          { value: "1", labelKey: "level1" },
          { value: "2", labelKey: "level2" },
          { value: "3", labelKey: "level3" },
          { value: "4", labelKey: "level4" },
          { value: "5", labelKey: "level5" },
          { value: "6", labelKey: "level6" },
          { value: "7", labelKey: "level7" },
          { value: "8", labelKey: "level8" },
          { value: "9", labelKey: "level9" },
        ],
      },
      {
        key: "school",
        labelKey: "filterSchool",
        type: "select",
        options: [
          { value: "", labelKey: "filterAny" },
          { value: "abjuration", labelKey: "schoolAbjuration" },
          { value: "conjuration", labelKey: "schoolConjuration" },
          { value: "divination", labelKey: "schoolDivination" },
          { value: "enchantment", labelKey: "schoolEnchantment" },
          { value: "evocation", labelKey: "schoolEvocation" },
          { value: "illusion", labelKey: "schoolIllusion" },
          { value: "necromancy", labelKey: "schoolNecromancy" },
          { value: "transmutation", labelKey: "schoolTransmutation" },
        ],
      },
    ],
  },
  monster: {
    slug: "monster",
    labelKey: "entityTypeMonster",
    filters: [
      {
        key: "cr",
        labelKey: "filterCr",
        type: "select",
        options: [
          { value: "", labelKey: "filterAny" },
          { value: "0", labelKey: "cr0" },
          { value: "0.125", labelKey: "cr18" },
          { value: "0.25", labelKey: "cr14" },
          { value: "0.5", labelKey: "cr12" },
          { value: "1", labelKey: "cr1" },
          { value: "2", labelKey: "cr2" },
          { value: "3", labelKey: "cr3" },
          { value: "5", labelKey: "cr5" },
          { value: "10", labelKey: "cr10" },
          { value: "15", labelKey: "cr15" },
          { value: "20", labelKey: "cr20" },
          { value: "30", labelKey: "cr30" },
        ],
      },
      {
        key: "type",
        labelKey: "filterMonsterType",
        type: "select",
        options: [
          { value: "", labelKey: "filterAny" },
          { value: "aberration", labelKey: "monsterAberration" },
          { value: "beast", labelKey: "monsterBeast" },
          { value: "celestial", labelKey: "monsterCelestial" },
          { value: "construct", labelKey: "monsterConstruct" },
          { value: "dragon", labelKey: "monsterDragon" },
          { value: "elemental", labelKey: "monsterElemental" },
          { value: "fey", labelKey: "monsterFey" },
          { value: "fiend", labelKey: "monsterFiend" },
          { value: "giant", labelKey: "monsterGiant" },
          { value: "humanoid", labelKey: "monsterHumanoid" },
          { value: "monstrosity", labelKey: "monsterMonstrosity" },
          { value: "ooze", labelKey: "monsterOoze" },
          { value: "plant", labelKey: "monsterPlant" },
          { value: "undead", labelKey: "monsterUndead" },
        ],
      },
    ],
  },
  class_feature: {
    slug: "class-feature",
    labelKey: "entityTypeClassFeature",
    filters: [],
  },
  feat: {
    slug: "feat",
    labelKey: "entityTypeFeat",
    filters: [],
  },
  magic_item: {
    slug: "magic-item",
    labelKey: "entityTypeMagicItem",
    filters: [
      {
        key: "rarity",
        labelKey: "filterRarity",
        type: "select",
        options: [
          { value: "", labelKey: "filterAny" },
          { value: "common", labelKey: "rarityCommon" },
          { value: "uncommon", labelKey: "rarityUncommon" },
          { value: "rare", labelKey: "rarityRare" },
          { value: "very_rare", labelKey: "rarityVeryRare" },
          { value: "legendary", labelKey: "rarityLegendary" },
          { value: "artifact", labelKey: "rarityArtifact" },
        ],
      },
    ],
  },
  species: {
    slug: "species",
    labelKey: "entityTypeSpecies",
    filters: [],
  },
  subclass: {
    slug: "subclass",
    labelKey: "entityTypeSubclass",
    filters: [],
  },
  background: {
    slug: "background",
    labelKey: "entityTypeBackground",
    filters: [],
  },
  other: {
    slug: "other",
    labelKey: "entityTypeOther",
    filters: [],
  },
};

export function getEntityTypeBySlug(slug: string): EntityType | null {
  for (const type of ENTITY_TYPES) {
    if (ENTITY_CONFIG[type].slug === slug) return type;
  }
  return null;
}

export type EntityRecord = Readonly<{
  id: string;
  fileId: string;
  sourceId: string;
  entityType: EntityType;
  name: string;
  description: string;
  attributes: EntityAttributes;
  pageNumbers: readonly number[];
  chunkIds: readonly string[];
  createdAt: string;
}>;

export type EntityInput = Readonly<{
  fileId: string;
  sourceId: string;
  entityType: EntityType;
  name: string;
  description: string;
  attributes: EntityAttributes;
  pageNumbers: readonly number[];
  chunkIds: readonly string[];
}>;
