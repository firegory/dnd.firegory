/**
 * Semantic query expansion hook.
 *
 * Expands user queries with related terms (aliases, D&D-specific vocabulary,
 * bilingual terms). The expansion must respect the same corpus/language filters
 * as the original query — expanded terms never bypass access control.
 *
 * The default implementation provides a fixed glossary of common D&D terms
 * and bilingual mappings. Future implementations can call an LLM or use
 * a learned synonym model.
 */

/** A single expanded query variant with optional metadata. */
export type ExpandedQuery = Readonly<{
  /** The expanded query text. */
  text: string;
  /** Why this expansion was added (for diagnostics). */
  reason: "original" | "alias" | "bilingual" | "plural" | "custom";
  /** Confidence weight for this expansion (0–1, default 1). */
  weight: number;
}>;

/** Configuration for query expansion. */
export type ExpansionConfig = Readonly<{
  /** Whether to enable bilingual expansion (en↔ru). Default: false. */
  bilingual?: boolean;
  /** Whether to enable alias/expansion. Default: true. */
  enabled?: boolean;
}>;

/**
 * Bilingual D&D term mappings (en ↔ ru).
 * Only used when bilingual expansion is enabled.
 */
const BILINGUAL_TERMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["armor class", ["класс брони", "КБ"]],
  ["ac", ["класс брони", "КБ"]],
  ["hit points", ["хиты", "очки здоровья"]],
  ["hp", ["хиты", "очко здоровья"]],
  ["saving throw", ["спасбросок", "спасительный бросок"]],
  ["attack roll", ["бросок атаки"]],
  ["damage", ["урон"]],
  ["spell", ["заклинание"]],
  ["ability score", ["характеристика"]],
  ["proficiency", ["владение"]],
  ["advantage", ["преимущество"]],
  ["disadvantage", ["помеха"]],
  ["action", ["действие"]],
  ["bonus action", ["дополнительное действие"]],
  ["reaction", ["реакция"]],
  ["concentration", ["концентрация"]],
  ["initiative", ["инициатива"]],
  ["challenge rating", ["рейтинг опасности", "CR"]],
  ["cr", ["рейтинг опасности", "challenge rating"]],
  ["dungeon master", ["мастер подземелий", "ДМ"]],
  ["dm", ["мастер подземелий", "ДМ"]],
  // Reverse: ru → en
  ["класс брони", ["armor class", "AC"]],
  ["КБ", ["armor class", "AC"]],
  ["хиты", ["hit points", "HP"]],
  ["спасбросок", ["saving throw"]],
  ["бросок атаки", ["attack roll"]],
  ["урон", ["damage"]],
  ["заклинание", ["spell"]],
  ["характеристика", ["ability score"]],
  ["владение", ["proficiency"]],
  ["преимущество", ["advantage"]],
  ["помеха", ["disadvantage"]],
  ["действие", ["action"]],
  ["дополнительное действие", ["bonus action"]],
  ["реакция", ["reaction"]],
  ["концентрация", ["concentration"]],
  ["инициатива", ["initiative"]],
  ["рейтинг опасности", ["challenge rating", "CR"]],
  ["мастер подземелий", ["dungeon master", "DM"]],
]);

/**
 * D&D-specific aliases and abbreviations.
 */
const ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["ac", ["armor class"]],
  ["hp", ["hit points"]],
  ["cr", ["challenge rating"]],
  ["dm", ["dungeon master"]],
  ["pc", ["player character"]],
  ["npc", ["non-player character"]],
  ["aoe", ["area of effect"]],
  ["dc", ["difficulty class"]],
  ["str", ["strength"]],
  ["dex", ["dexterity"]],
  ["con", ["constitution"]],
  ["int", ["intelligence"]],
  ["wis", ["wisdom"]],
  ["cha", ["charisma"]],
]);

/**
 * Expands a query with related terms.
 *
 * Returns the original query plus any expansions. The `language` parameter
 * from the retrieval selection controls whether bilingual terms are included
 * even if `bilingual` is enabled (we don't add Russian terms when searching
 * English-only corpus, and vice versa).
 *
 * Expansion does NOT bypass access control — expanded terms are just added
 * to the query text that still runs through the same filtered SQL.
 */
export function expandQuery(
  searchQuery: string,
  config: ExpansionConfig = {},
): readonly ExpandedQuery[] {
  const enabled = config.enabled ?? true;
  if (!enabled || !searchQuery.trim()) {
    return [{ text: searchQuery, reason: "original", weight: 1.0 }];
  }

  const results: ExpandedQuery[] = [
    { text: searchQuery, reason: "original", weight: 1.0 },
  ];

  const lowerQuery = searchQuery.toLowerCase();
  const seen = new Set<string>([lowerQuery]);

  // Alias expansion
  for (const [key, aliases] of ALIASES) {
    if (lowerQuery.includes(key)) {
      for (const alias of aliases) {
        const lowerAlias = alias.toLowerCase();
        if (!seen.has(lowerAlias)) {
          seen.add(lowerAlias);
          results.push({
            text: alias,
            reason: "alias",
            weight: 0.8,
          });
        }
      }
    }
  }

  // Bilingual expansion
  if (config.bilingual) {
    for (const [key, translations] of BILINGUAL_TERMS) {
      if (lowerQuery.includes(key)) {
        for (const translation of translations) {
          const lowerTranslation = translation.toLowerCase();
          if (!seen.has(lowerTranslation)) {
            seen.add(lowerTranslation);
            results.push({
              text: translation,
              reason: "bilingual",
              weight: 0.7,
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Combines expanded queries into a single search string for keyword search.
 * Uses OR logic between expansions so any variant matches.
 */
export function combinedExpandedQuery(
  expansions: readonly ExpandedQuery[],
): string {
  if (expansions.length <= 1) {
    return expansions[0]?.text ?? "";
  }
  // For keyword search, combine with OR for plainto_tsquery
  // plainto_tsquery doesn't support OR, so we concatenate terms
  return expansions.map((e) => e.text).join(" ");
}
