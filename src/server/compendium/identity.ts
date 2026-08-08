import { createHash } from "node:crypto";

const STABLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const ENTRY_TYPES = new Set(["spell", "creature", "item", "class", "feature", "species", "background", "feat", "equipment", "glossary", "guide"]);
const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export class CompendiumIdentityError extends Error {}

export function stableCandidateKey(value: string): string {
  const transliterated = value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase("und").replace(/[а-яё]/g, (letter) => CYRILLIC[letter] ?? "");
  const key = transliterated.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128).replace(/-+$/g, "");
  if (!key) throw new CompendiumIdentityError(`Unable to form a stable candidate key from ${value}.`);
  return key;
}

export function canonicalEntryId(entryType: string, candidateKey: string): string {
  if (!ENTRY_TYPES.has(entryType) || !STABLE_ID.test(candidateKey)) throw new CompendiumIdentityError("Canonical identity requires a supported entry type and stable candidate key.");
  const value = `${entryType}-${candidateKey}`;
  if (value.length <= 128) return value;
  const suffix = createHash("sha256").update(`${entryType}\0${candidateKey}`).digest("hex").slice(0, 16);
  return `${entryType}-${candidateKey.slice(0, 128 - entryType.length - suffix.length - 2)}-${suffix}`;
}

export function collectorCandidateKey(category: string, entryType: string, externalId: string): string {
  const externalKey = stableCandidateKey(externalId);
  return entryType === "class" || entryType === "species" ? externalKey : stableCandidateKey(`${category}-${externalKey}`);
}

export function collectorCanonicalEntryId(entryType: "class" | "species", externalId: string): string {
  return canonicalEntryId(entryType, collectorCandidateKey(entryType, entryType, externalId));
}
