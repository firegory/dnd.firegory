import { SOURCE_CATEGORIES, SOURCE_EDITIONS, SOURCE_LANGUAGES, type RetrievalSelection } from "../access/retrieval-filter.ts";
import { FlatReadInputError, type FlatListOptions } from "./flat-read-service.ts";
import { FLAT_ENTRY_TYPES, flatCollection, type FlatEntryType } from "./flat-schema.ts";
export { flatCollection };
const COLLECTION_TYPES: Readonly<Record<string, FlatEntryType>> = { feats: "feat", backgrounds: "background", items: "item", equipment: "equipment", glossary: "glossary" };

export function parseFlatType(value: string): FlatEntryType {
  const singular = COLLECTION_TYPES[value] ?? value;
  if (!FLAT_ENTRY_TYPES.includes(singular as FlatEntryType)) throw new FlatReadInputError("Unsupported flat compendium type.");
  return singular as FlatEntryType;
}
export function parseFlatListOptions(url: URL): FlatListOptions {
  const text = (name: string) => optionalText(url, name);
  const bool = (name: string) => { const value = text(name); if (value === undefined) return undefined; if (value === "true") return true; if (value === "false") return false; throw new FlatReadInputError(`${name} must be true or false.`); };
  const number = (name: string) => { const value = text(name); if (value === undefined) return undefined; if (!/^\d+(?:\.\d+)?$/.test(value)) throw new FlatReadInputError(`${name} must be a nonnegative number.`); return Number(value); };
  const edition = text("edition"), language = text("language"), categorySelection = text("sourceCategory");
  if (edition && !SOURCE_EDITIONS.includes(edition as never)) throw new FlatReadInputError("Invalid edition.");
  if (language && !SOURCE_LANGUAGES.includes(language as never)) throw new FlatReadInputError("Invalid language.");
  if (categorySelection && !SOURCE_CATEGORIES.includes(categorySelection as never)) throw new FlatReadInputError("Invalid source category.");
  return compact({
    query: text("q"), entryCategory: text("category"), rarity: text("rarity"), ability: text("ability"), skill: text("skill"), related: text("related"),
    attunement: bool("attunement"), repeatable: bool("repeatable"), minLevel: number("minLevel"), maxLevel: number("maxLevel"),
    minCost: number("minCost"), maxCost: number("maxCost"), minWeight: number("minWeight"), maxWeight: number("maxWeight"),
    cursor: text("cursor"), limit: number("limit"), edition: edition as RetrievalSelection["edition"], language: language as RetrievalSelection["language"],
    sourceCategory: categorySelection as RetrievalSelection["category"],
  }) as FlatListOptions;
}
export function flatSelection(options: FlatListOptions): RetrievalSelection { return compact({ edition: options.edition, language: options.language, category: options.sourceCategory }) as RetrievalSelection; }
function optionalText(url: URL, name: string): string | undefined { const values = url.searchParams.getAll(name); if (values.length > 1) throw new FlatReadInputError(`${name} may only be provided once.`); return values[0]?.normalize("NFC").trim() || undefined; }
function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
