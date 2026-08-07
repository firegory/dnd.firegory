import type { CompendiumEntryType } from "./service.ts";
import type { GuideLocale } from "./guides.ts";

export const COMPENDIUM_CATEGORIES: readonly Readonly<{
  entryType: CompendiumEntryType;
  mark: string;
  label: Readonly<Record<GuideLocale, string>>;
  description: Readonly<Record<GuideLocale, string>>;
}>[] = [
  { entryType: "class", mark: "I", label: { ru: "Классы", en: "Classes" }, description: { ru: "Пути развития героев", en: "Paths for adventuring heroes" } },
  { entryType: "species", mark: "II", label: { ru: "Виды", en: "Species" }, description: { ru: "Наследие и особенности", en: "Heritage and traits" } },
  { entryType: "background", mark: "III", label: { ru: "Предыстории", en: "Backgrounds" }, description: { ru: "Прошлое и начальные навыки", en: "History and starting talents" } },
  { entryType: "feat", mark: "IV", label: { ru: "Черты", en: "Feats" }, description: { ru: "Особые способности", en: "Special capabilities" } },
  { entryType: "spell", mark: "V", label: { ru: "Заклинания", en: "Spells" }, description: { ru: "Магия по кругам и школам", en: "Magic by level and school" } },
  { entryType: "feature", mark: "VI", label: { ru: "Глоссарий", en: "Glossary" }, description: { ru: "Термины и правила", en: "Rules terms and features" } },
  { entryType: "creature", mark: "VII", label: { ru: "Бестиарий", en: "Bestiary" }, description: { ru: "Существа и противники", en: "Creatures and adversaries" } },
  { entryType: "item", mark: "VIII", label: { ru: "Магические предметы", en: "Magic items" }, description: { ru: "Сокровища и артефакты", en: "Treasure and artifacts" } },
  { entryType: "equipment", mark: "IX", label: { ru: "Снаряжение", en: "Equipment" }, description: { ru: "Оружие, доспехи и инструменты", en: "Weapons, armor, and tools" } },
];

export function categoryByEntryType(value: string) {
  return COMPENDIUM_CATEGORIES.find(({ entryType }) => entryType === value) ?? null;
}
