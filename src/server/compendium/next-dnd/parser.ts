import { createHash } from "node:crypto";

import * as cheerio from "cheerio";

import type { CompendiumEntryType } from "../service.ts";

export const NEXT_DND_PARSER_VERSION = "next-dnd-2024-v3";

export const NEXT_DND_CATEGORIES = {
  class: { path: "/class/", entryType: "class" },
  species: { path: "/species/", entryType: "species" },
  backgrounds: { path: "/backgrounds/", entryType: "background" },
  feats: { path: "/feats/", entryType: "feat" },
  spells: { path: "/spells/", entryType: "spell" },
  glossary: { path: "/glossary/", entryType: "glossary" },
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
  cardFingerprintSha256: string;
}>;

export type NextDndIndex = Readonly<{
  category: NextDndCategory;
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
  if (parsed.category.trim() !== expectedCategory) {
    throw new Error(`window.LIST category "${parsed.category.trim()}" does not match requested category "${expectedCategory}".`);
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
  return { category: expectedCategory, order, entries };
}

export type NextDndNormalizedDetail = Readonly<{
  title: string;
  contentHtml: string;
  contentText: string;
}>;

const ALLOWED_TAGS = new Set([
  "article", "section", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "ul", "ol", "li",
  "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "blockquote", "pre", "code", "br", "hr", "a",
]);
const REMOVED_TAGS = "script,style,svg,math,iframe,frame,frameset,object,embed,img,picture,source,video,audio,link,meta,base,canvas,template,noscript,form,input,button,select,textarea";
const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  th: new Set(["colspan", "rowspan"]),
  td: new Set(["colspan", "rowspan"]),
};

export function parseNextDndDetail(html: string, cardCategory: string, externalId: string): NextDndNormalizedDetail {
  if (!/^[a-z][a-z0-9_-]*$/.test(cardCategory)) throw new Error(`Invalid detail card category ${cardCategory}.`);
  if (!/^\d+$/.test(externalId)) throw new Error(`Invalid detail external ID ${externalId}.`);
  const $ = cheerio.load(html, { xmlMode: false });
  const card = $(".card[data-id]").filter((_, element) => {
    const id = $(element).attr("data-id");
    return id === `${cardCategory}:${externalId}`;
  }).first();
  if (card.length === 0) throw new Error(`Detail page does not contain exact card ${cardCategory}:${externalId}.`);
  if (!new Set(["article", "section", "div"]).has(card[0].tagName.toLowerCase())) throw new Error("Detail card root element is not allowed.");

  card.find([
    "nav", "aside", "header", "footer", "form", "script", "style",
    ".comments", ".comment", ".card-comments", ".form-auth", ".partner", ".partners",
    ".card-menu", ".card__buttons", ".card__footer", "[data-comment]",
  ].join(",")).remove();
  const titleNode = card.find(".card-title").first();
  const title = (titleNode.find("[data-copy]").attr("data-copy") ?? titleNode.text()).replace(/\s+/g, " ").trim();
  card.find(REMOVED_TAGS).remove();
  card.find("*").addBack().each((_, element) => {
    if (element.type !== "tag") return;
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      $(element).replaceWith($(element).contents());
      return;
    }
    const allowed = ALLOWED_ATTRIBUTES[tag] ?? new Set<string>();
    for (const attribute of Object.keys(element.attribs)) {
      if (!allowed.has(attribute.toLowerCase())) $(element).removeAttr(attribute);
    }
    if (tag === "a") {
      const href = $(element).attr("href");
      if (href && !safeLink(href)) $(element).removeAttr("href");
    }
  });
  const textCard = card.clone();
  textCard.find("br").replaceWith("\n");
  textCard.find("h1,h2,h3,h4,h5,h6,p,li,dt,dd,tr,blockquote,pre,section").each((_, element) => {
    $(element).append("\n");
  });
  const contentText = textCard.text().replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
  if (!title || !contentText) throw new Error(`Detail card ${cardCategory}:${externalId} has no normalized content.`);
  return { title, contentHtml: $.html(card), contentText };
}

function safeLink(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("#")) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
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
    cardFingerprintSha256: nextDndCardFingerprint(value),
  };
}

export function nextDndCardFingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("window.LIST card is not JSON serializable.");
  return encoded;
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
