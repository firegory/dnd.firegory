import type { UserRole } from "../auth/types.ts";

export const GUIDE_LOCALES = ["ru", "en"] as const;
export type GuideLocale = (typeof GUIDE_LOCALES)[number];
export const GUIDE_SLUGS = ["starter", "basics", "character-creation"] as const;
export type GuideSlug = (typeof GUIDE_SLUGS)[number];

type GuideCitation = Readonly<{
  label: string;
  url: string;
  locator: string;
  attribution: string;
}>;

export type GuideBlock =
  | Readonly<{ id: string; kind: "paragraph" | "callout"; heading?: string; text: string; citation: GuideCitation }>
  | Readonly<{ id: string; kind: "steps" | "list"; heading: string; items: readonly string[]; citation: GuideCitation }>;

export type GuideDocument = Readonly<{
  schemaVersion: 1;
  slug: GuideSlug;
  locale: GuideLocale;
  accessTier: "open" | "premium";
  title: string;
  summary: string;
  blocks: readonly GuideBlock[];
  review: Readonly<{ workflow: "#76"; status: "approved" }>;
}>;

const source = {
  ru: (locator: string): GuideCitation => ({
    label: "Бесплатные правила D&D (2024)",
    url: "https://www.dndbeyond.com/sources/dnd/free-rules",
    locator,
    attribution: "Основано на D&D Free Rules (2024), Wizards of the Coast.",
  }),
  en: (locator: string): GuideCitation => ({
    label: "D&D Free Rules (2024)",
    url: "https://www.dndbeyond.com/sources/dnd/free-rules",
    locator,
    attribution: "Based on D&D Free Rules (2024), Wizards of the Coast.",
  }),
};

const guides: readonly GuideDocument[] = [
  {
    schemaVersion: 1, slug: "starter", locale: "ru", accessTier: "open",
    title: "Первый вечер за столом", summary: "Что приготовить и как начать первую сцену без лишней теории.",
    review: { workflow: "#76", status: "approved" },
    blocks: [
      { id: "table", kind: "steps", heading: "Перед игрой", items: ["Выберите ведущего и готовых персонажей.", "Приготовьте листы персонажей, карандаши и набор костей.", "Договоритесь о продолжительности и границах игры."], citation: source.ru("Playing the Game") },
      { id: "loop", kind: "callout", heading: "Главный цикл", text: "Ведущий описывает ситуацию, игроки говорят, что делают персонажи, а правила и броски определяют последствия, когда исход неочевиден.", citation: source.ru("How to Play") },
      { id: "next", kind: "paragraph", text: "Начните с короткой цели, дайте каждому персонажу повод действовать и завершите встречу вопросом о следующем шаге группы.", citation: source.ru("The Three Pillars of Adventure") },
    ],
  },
  {
    schemaVersion: 1, slug: "starter", locale: "en", accessTier: "open",
    title: "Your first night at the table", summary: "Prepare the essentials and begin the first scene without a rules lecture.",
    review: { workflow: "#76", status: "approved" },
    blocks: [
      { id: "table", kind: "steps", heading: "Before play", items: ["Choose a Dungeon Master and ready-to-play characters.", "Bring character sheets, pencils, and a set of dice.", "Agree on the session length and table boundaries."], citation: source.en("Playing the Game") },
      { id: "loop", kind: "callout", heading: "The core loop", text: "The DM describes a situation, players say what their characters do, and the rules and dice resolve consequences when the outcome is uncertain.", citation: source.en("How to Play") },
      { id: "next", kind: "paragraph", text: "Start with one short objective, give every character a reason to act, and end by asking what the group wants to do next.", citation: source.en("The Three Pillars of Adventure") },
    ],
  },
  {
    schemaVersion: 1, slug: "basics", locale: "ru", accessTier: "open",
    title: "Основы правил", summary: "Проверки, преимущества, бой и отдых в одной короткой памятке.",
    review: { workflow: "#76", status: "approved" },
    blocks: [
      { id: "tests", kind: "paragraph", heading: "Проверки d20", text: "Бросьте d20, добавьте подходящий модификатор и сравните результат с целевым числом. Преимущество и помеха меняют бросок, а не складываются многократно.", citation: source.ru("D20 Tests") },
      { id: "turn", kind: "list", heading: "Ваш ход", items: ["Переместитесь в пределах Скорости.", "Выполните одно действие.", "Используйте бонусное действие или реакцию только когда правило их предоставляет."], citation: source.ru("Combat / Your Turn") },
      { id: "rest", kind: "callout", heading: "После опасности", text: "Короткий и продолжительный отдых восстанавливают разные ресурсы. Записывайте потраченные кости хитов, ячейки и способности прямо на листе.", citation: source.ru("Resting") },
    ],
  },
  {
    schemaVersion: 1, slug: "basics", locale: "en", accessTier: "open",
    title: "Rules basics", summary: "D20 tests, advantage, combat, and rests in one short reference.",
    review: { workflow: "#76", status: "approved" },
    blocks: [
      { id: "tests", kind: "paragraph", heading: "D20 tests", text: "Roll a d20, add the relevant modifier, and compare the total with the target number. Advantage and disadvantage change the roll and do not stack repeatedly.", citation: source.en("D20 Tests") },
      { id: "turn", kind: "list", heading: "Your turn", items: ["Move up to your Speed.", "Take one action.", "Use a Bonus Action or Reaction only when a rule grants one."], citation: source.en("Combat / Your Turn") },
      { id: "rest", kind: "callout", heading: "After danger", text: "Short and Long Rests restore different resources. Mark spent Hit Dice, spell slots, and features on the character sheet as play continues.", citation: source.en("Resting") },
    ],
  },
  {
    schemaVersion: 1, slug: "character-creation", locale: "ru", accessTier: "premium",
    title: "Создание персонажа", summary: "Последовательность решений от идеи героя до готового листа.",
    review: { workflow: "#76", status: "approved" },
    blocks: [
      { id: "choices", kind: "steps", heading: "Соберите героя", items: ["Выберите класс.", "Определите происхождение: предысторию и вид.", "Назначьте характеристики и запишите владения.", "Выберите снаряжение и завершите детали личности."], citation: source.ru("Creating a Character") },
      { id: "numbers", kind: "paragraph", heading: "Проверьте числа", text: "Запишите бонус мастерства, класс доспеха, хиты, инициативу, скорость, спасброски и атаки. Значения должны следовать выбранному классу, происхождению и снаряжению.", citation: source.ru("Character Sheet") },
      { id: "table", kind: "callout", heading: "Свяжите персонажа с игрой", text: "Сформулируйте одну причину идти в приключение и одну связь с другим героем. Согласуйте спорные детали с ведущим до первой сцены.", citation: source.ru("Creating a Character / Session Zero") },
    ],
  },
  {
    schemaVersion: 1, slug: "character-creation", locale: "en", accessTier: "premium",
    title: "Character creation", summary: "Follow the decisions from a hero concept to a ready character sheet.",
    review: { workflow: "#76", status: "approved" },
    blocks: [
      { id: "choices", kind: "steps", heading: "Build the hero", items: ["Choose a class.", "Choose an origin: background and species.", "Assign ability scores and record proficiencies.", "Choose equipment and finish the character details."], citation: source.en("Creating a Character") },
      { id: "numbers", kind: "paragraph", heading: "Check the numbers", text: "Record Proficiency Bonus, Armor Class, Hit Points, Initiative, Speed, saving throws, and attacks. Each value should follow from the chosen class, origin, and equipment.", citation: source.en("Character Sheet") },
      { id: "table", kind: "callout", heading: "Connect the character", text: "Write one reason to adventure and one connection to another hero. Agree on uncertain details with the DM before the first scene.", citation: source.en("Creating a Character / Session Zero") },
    ],
  },
];

export function isGuideLocale(value: string): value is GuideLocale {
  return GUIDE_LOCALES.includes(value as GuideLocale);
}

export function isGuideSlug(value: string): value is GuideSlug {
  return GUIDE_SLUGS.includes(value as GuideSlug);
}

export function canReadGuide(role: UserRole, document: Pick<GuideDocument, "accessTier">): boolean {
  return document.accessTier === "open" || role === "premium" || role === "admin";
}

export function getGuide(slug: GuideSlug, locale: GuideLocale, role: UserRole): GuideDocument | null {
  const document = guides.find((guide) => guide.slug === slug && guide.locale === locale) ?? null;
  return document && canReadGuide(role, document) ? document : null;
}

export function listGuides(locale: GuideLocale, role: UserRole): readonly GuideDocument[] {
  return guides.filter((guide) => guide.locale === locale && canReadGuide(role, guide));
}
