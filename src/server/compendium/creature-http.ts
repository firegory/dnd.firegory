import { SOURCE_CATEGORIES, SOURCE_EDITIONS, SOURCE_LANGUAGES, type RetrievalSelection } from "../access/retrieval-filter.ts";
import { CreatureReadInputError, type CreatureListOptions } from "./creature-read-service.ts";
import { CREATURE_SIZES, normalizeChallengeRating, type CreatureSize } from "./creature-schema.ts";

export function parseCreatureListOptions(url: URL): CreatureListOptions {
  const sizes = values(url, "size").map((value) => { if (!CREATURE_SIZES.includes(value as CreatureSize)) throw new CreatureReadInputError("Invalid creature size."); return value as CreatureSize; });
  const types = values(url, "type"); const alignment = optional(url, "alignment"); const query = optional(url, "q");
  const challenges = values(url, "cr").map((value) => normalizeChallengeRating(value));
  const minChallenge = optional(url, "crMin"); const maxChallenge = optional(url, "crMax");
  const cursor = optional(url, "cursor"); const limit = optional(url, "limit");
  if (limit && !/^\d+$/.test(limit)) throw new CreatureReadInputError("Invalid creature limit.");
  return { ...selection(url), ...(sizes.length ? { sizes } : {}), ...(types.length ? { types } : {}), ...(alignment ? { alignment } : {}),
    ...(challenges.length ? { challenges } : {}), ...(minChallenge ? { minChallenge: normalizeChallengeRating(minChallenge) } : {}),
    ...(maxChallenge ? { maxChallenge: normalizeChallengeRating(maxChallenge) } : {}), ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}), ...(limit ? { limit: Number(limit) } : {}) };
}
export function creatureSelection(options: CreatureListOptions): RetrievalSelection { return { ...(options.edition ? { edition: options.edition } : {}), ...(options.language ? { language: options.language } : {}), ...(options.category ? { category: options.category } : {}) }; }
function selection(url: URL): RetrievalSelection { const edition = optional(url, "edition"); const language = optional(url, "language"); const category = optional(url, "category"); if (edition && !SOURCE_EDITIONS.includes(edition as never)) throw new CreatureReadInputError("Invalid edition."); if (language && !SOURCE_LANGUAGES.includes(language as never)) throw new CreatureReadInputError("Invalid language."); if (category && !SOURCE_CATEGORIES.includes(category as never)) throw new CreatureReadInputError("Invalid category."); return { ...(edition ? { edition: edition as RetrievalSelection["edition"] } : {}), ...(language ? { language: language as RetrievalSelection["language"] } : {}), ...(category ? { category: category as RetrievalSelection["category"] } : {}) }; }
function values(url: URL, key: string): string[] { return [...new Set(url.searchParams.getAll(key).flatMap((value) => value.split(",")).map((value) => value.normalize("NFC").trim()).filter(Boolean))]; }
function optional(url: URL, key: string): string | undefined { const found = url.searchParams.getAll(key); if (found.length > 1) throw new CreatureReadInputError(`${key} may only be provided once.`); return found[0]?.normalize("NFC").trim() || undefined; }
