import * as cheerio from "cheerio";

import type { CompendiumEntryType } from "../service.ts";

export const NEXT_DND_PARSER_VERSION = "next-dnd-2024-v1";

export const NEXT_DND_CATEGORIES = {
  class: { path: "/class/", entryType: "class" },
  species: { path: "/species/", entryType: "species" },
  backgrounds: { path: "/backgrounds/", entryType: "background" },
  feats: { path: "/feats/", entryType: "feat" },
  spells: { path: "/spells/", entryType: "spell" },
  glossary: { path: "/glossary/", entryType: "feature" },
  bestiary: { path: "/bestiary/", entryType: "creature" },
  items: { path: "/items/", entryType: "item" },
  equipment: { path: "/equipment/", entryType: "equipment" },
} as const satisfies Record<string, { path: string; entryType: CompendiumEntryType }>;

export type NextDndCategory = keyof typeof NEXT_DND_CATEGORIES;

export type NextDndIndexEntry = Readonly<{
  category: NextDndCategory;
  externalId: string;
  sourceUrl: string;
  title: string;
  titleEn: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type NextDndIndex = Readonly<{
  category: string;
  order: Readonly<Record<string, string>>;
  entries: readonly NextDndIndexEntry[];
}>;

type ListCard = Record<string, unknown> & { link?: unknown; title?: unknown; title_en?: unknown };

export function parseNextDndIndex(html: string, indexUrl: string, expectedCategory: NextDndCategory): NextDndIndex {
  const json = extractAssignedObject(html, "window.LIST");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`window.LIST is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cards) || typeof parsed.category !== "string" || !parsed.category.trim()) {
    throw new Error("window.LIST must contain cards and a nonempty category.");
  }

  const entries = parsed.cards.map((value, index) => parseListCard(value, index, indexUrl, expectedCategory));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.externalId)) throw new Error(`window.LIST contains duplicate external ID ${entry.externalId}.`);
    ids.add(entry.externalId);
  }
  const order = isRecord(parsed.order)
    ? Object.fromEntries(Object.entries(parsed.order).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  return { category: parsed.category.trim(), order, entries };
}

export type NextDndNormalizedDetail = Readonly<{
  title: string;
  contentHtml: string;
  contentText: string;
}>;

export function parseNextDndDetail(html: string, category: NextDndCategory, externalId: string): NextDndNormalizedDetail {
  const $ = cheerio.load(html, { xmlMode: false });
  const card = $(".card[data-id]").filter((_, element) => {
    const id = $(element).attr("data-id");
    return id === `${category}:${externalId}` || id?.endsWith(`:${externalId}`) === true;
  }).first();
  if (card.length === 0) throw new Error(`Detail page does not contain card ${category}:${externalId}.`);

  card.find([
    "nav", "aside", "header", "footer", "form", "script", "style",
    ".comments", ".comment", ".card-comments", ".form-auth", ".partner", ".partners",
    ".card-menu", ".card__buttons", ".card__footer", "[data-comment]",
  ].join(",")).remove();
  const titleNode = card.find(".card-title").first();
  const title = (titleNode.find("[data-copy]").attr("data-copy") ?? titleNode.text()).replace(/\s+/g, " ").trim();
  const contentText = card.text().replace(/\s+/g, " ").trim();
  if (!title || !contentText) throw new Error(`Detail card ${category}:${externalId} has no normalized content.`);
  return { title, contentHtml: $.html(card), contentText };
}

function parseListCard(value: unknown, index: number, indexUrl: string, category: NextDndCategory): NextDndIndexEntry {
  if (!isRecord(value)) throw new Error(`window.LIST card ${index} is not an object.`);
  const card = value as ListCard;
  if (typeof card.link !== "string" || typeof card.title !== "string") {
    throw new Error(`window.LIST card ${index} lacks a string link or title.`);
  }
  const sourceUrl = new URL(card.link, indexUrl);
  const expectedPath = NEXT_DND_CATEGORIES[category].path;
  if (sourceUrl.origin !== new URL(indexUrl).origin || !sourceUrl.pathname.startsWith(expectedPath)) {
    throw new Error(`window.LIST card ${index} points outside ${expectedPath}.`);
  }
  const idMatch = sourceUrl.pathname.slice(expectedPath.length).match(/^(\d+)(?:-|\/|$)/);
  if (!idMatch) throw new Error(`window.LIST card ${index} has no numeric external ID.`);
  return {
    category,
    externalId: idMatch[1],
    sourceUrl: sourceUrl.href,
    title: card.title.trim(),
    titleEn: typeof card.title_en === "string" && card.title_en.trim() ? card.title_en.trim() : null,
    metadata: value,
  };
}

function extractAssignedObject(html: string, variable: string): string {
  const assignment = new RegExp(`${variable.replace(".", "\\.")}\\s*=\\s*`, "g").exec(html);
  if (!assignment) throw new Error(`${variable} assignment was not found.`);
  const start = assignment.index + assignment[0].length;
  if (html[start] !== "{") throw new Error(`${variable} must be assigned a JSON object.`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`${variable} JSON object is unterminated.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
