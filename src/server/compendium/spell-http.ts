import {
  SOURCE_CATEGORIES, SOURCE_EDITIONS, SOURCE_LANGUAGES, type RetrievalSelection,
} from "../access/retrieval-filter.ts";
import { SpellReadInputError, type SpellListOptions } from "./spell-read-service.ts";
import { SPELL_SCHOOLS, type SpellSchool } from "./spell-schema.ts";

export function parseSpellListOptions(url: URL): SpellListOptions {
  const levels = values(url, "level").map((value) => {
    if (!/^\d$/.test(value)) throw new SpellReadInputError("Invalid spell level.");
    return Number(value);
  });
  const schools = values(url, "school").map((value) => {
    if (!SPELL_SCHOOLS.includes(value as SpellSchool)) throw new SpellReadInputError("Invalid spell school.");
    return value as SpellSchool;
  });
  const ritual = optionalBoolean(url, "ritual");
  const concentration = optionalBoolean(url, "concentration");
  const className = optionalText(url, "class");
  const castingTime = optionalText(url, "casting");
  const range = optionalText(url, "range");
  const duration = optionalText(url, "duration");
  const components = values(url, "component");
  const query = optionalText(url, "q");
  const cursor = optionalText(url, "cursor");
  const limitRaw = optionalText(url, "limit");
  if (limitRaw && !/^\d+$/.test(limitRaw)) throw new SpellReadInputError("Invalid spell limit.");
  return {
    ...parseSpellSelection(url),
    ...(levels.length ? { levels } : {}),
    ...(schools.length ? { schools } : {}),
    ...(ritual !== undefined ? { ritual } : {}),
    ...(concentration !== undefined ? { concentration } : {}),
    ...(className ? { className } : {}),
    ...(castingTime ? { castingTime } : {}),
    ...(range ? { range } : {}),
    ...(duration ? { duration } : {}),
    ...(components.length ? { components } : {}),
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
  };
}

function parseSpellSelection(url: URL): RetrievalSelection {
  const edition = optionalText(url, "edition");
  const language = optionalText(url, "language");
  const category = optionalText(url, "category");
  if (edition && !SOURCE_EDITIONS.includes(edition as never)) throw new SpellReadInputError("Invalid edition.");
  if (language && !SOURCE_LANGUAGES.includes(language as never)) throw new SpellReadInputError("Invalid language.");
  if (category && !SOURCE_CATEGORIES.includes(category as never)) throw new SpellReadInputError("Invalid category.");
  return {
    ...(edition ? { edition: edition as RetrievalSelection["edition"] } : {}),
    ...(language ? { language: language as RetrievalSelection["language"] } : {}),
    ...(category ? { category: category as RetrievalSelection["category"] } : {}),
  };
}

export function spellSelection(options: SpellListOptions): RetrievalSelection {
  return {
    ...(options.edition ? { edition: options.edition } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.category ? { category: options.category } : {}),
  };
}

function values(url: URL, name: string): string[] {
  return [...new Set(url.searchParams.getAll(name).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

function optionalBoolean(url: URL, name: string): boolean | undefined {
  const value = optionalText(url, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new SpellReadInputError(`${name} must be true or false.`);
}

function optionalText(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new SpellReadInputError(`${name} may only be provided once.`);
  const value = values[0]?.normalize("NFC").trim();
  return value || undefined;
}
