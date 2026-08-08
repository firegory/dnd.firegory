import { nextDndCardFingerprint } from "../../../src/server/compendium/next-dnd/parser.ts";

const records = [
  { category: "feats", id: "201", title: "Наблюдательный", titleEn: "Observant", text: "Черта. Требование: 4 уровень. Эту черту нельзя брать повторно.", attributes: { category: "general", prerequisiteLevel: 4, prerequisiteText: "4 level", repeatable: false } },
  { category: "backgrounds", id: "301", title: "Ремесленник", titleEn: "Artisan", text: "Предыстория. Характеристики: Интеллект, Мудрость. Владение навыками: Проницательность, Убеждение.", attributes: { abilityScores: ["Интеллект", "Мудрость"], skillProficiencies: ["Проницательность", "Убеждение"] } },
  { category: "items", id: "401", title: "Кольцо защиты", titleEn: "Ring of Protection", text: "Магический предмет, кольцо, редкий. Требует настройки.", attributes: { category: "ring", rarity: "rare", requiresAttunement: true } },
  { category: "equipment", id: "501", title: "Верёвка", titleEn: "Rope", text: "Снаряжение. Стоимость: 1 зм. Вес: 10 фунтов.", attributes: { category: "adventuring_gear", costCp: 100, weightLb: 10 } },
  { category: "glossary", id: "601", title: "Укрытие", titleEn: "Cover", text: "Термин правил. Укрытие повышает КД и спасброски Ловкости.", attributes: { category: "combat", relatedTerms: ["КД", "Спасбросок"] } },
] as const;

export function flatDetailsFixture() {
  return records.map((record, index) => {
    const indexMetadata = { title_en: record.titleEn, typed_fields: record.attributes };
    const indexHash = String(index + 1).repeat(64).slice(0, 64);
    const detailHash = String(index + 6).repeat(64).slice(0, 64);
    return {
      category: record.category, externalId: record.id,
      sourceUrl: `https://next.dnd.su/${record.category}/${record.id}-fixture`, finalUrl: `https://next.dnd.su/${record.category}/${record.id}-fixture`, redirectChain: [],
      fetchedAt: "2026-08-07T12:00:00.000Z", sha256: detailHash, byteLength: 512,
      parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${detailHash}.html`, kind: "detail",
      normalized: { title: record.title, contentHtml: `<article>${record.title}</article>`, contentText: record.text },
      indexMetadata,
      indexSource: { url: `https://next.dnd.su/${record.category}/`, fingerprintSha256: indexHash, rawBlobPath: `blobs/${indexHash}.html`, fetchedAt: "2026-08-07T11:59:00.000Z", cardFingerprintSha256: nextDndCardFingerprint(indexMetadata) },
    };
  });
}
