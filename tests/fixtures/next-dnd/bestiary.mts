import { nextDndCardFingerprint, parseNextDndDetail } from "../../../src/server/compendium/next-dnd/parser.ts";

export function ancientDragonDetail() {
  const indexMetadata = { title: "Древний красный дракон", title_en: "Ancient Red Dragon", size: "gargantuan", type: "dragon", challenge_rating: "24" };
  const html = `<article class="card" data-id="bestiary:999"><h1 class="card-title" data-copy="Древний красный дракон">Древний красный дракон</h1>
    <p>Gargantuan dragon, chaotic evil.</p><p>Armor Class 22 (natural armor)</p><p>Hit Points 546 (28d20 + 252)</p>
    <p>Speed 40 ft., climb 40 ft., fly 80 ft.</p><p>STR 30 (+10) DEX 10 (+0) CON 29 (+9) INT 18 (+4) WIS 15 (+2) CHA 23 (+6)</p>
    <p>Saving Throws DEX +7, CON +16, WIS +9, CHA +13</p><p>Skills Perception +16, Stealth +7</p>
    <p>Damage Resistances fire</p><p>Damage Immunities poison</p><p>Condition Immunities frightened</p>
    <p>Senses blindsight 60 ft., darkvision 120 ft., passive Perception 26</p><p>Languages Common, Draconic</p><p>Challenge Rating 24 (62,000 XP)</p>
    <h2>Traits</h2><p><strong>Legendary Resistance.</strong> If the dragon fails a saving throw, it can choose to succeed instead.</p><p><strong>Fire Aura.</strong> A creature that starts its turn nearby takes fire damage.</p>
    <h2>Actions</h2><p><strong>Multiattack.</strong> The dragon makes three attacks.</p><p><strong>Fire Breath.</strong> Each creature in a cone makes a Dexterity save.</p>
    <h2>Bonus Actions</h2><p><strong>Wing Buffet.</strong> The dragon beats its wings.</p><h2>Reactions</h2><p><strong>Retaliatory Tail.</strong> The dragon makes one tail attack.</p>
    <h2>Legendary Actions</h2><p><strong>Detect.</strong> The dragon makes a Wisdom check.</p><p><strong>Tail Attack.</strong> The dragon makes a tail attack.</p></article>`;
  return {
    category: "bestiary", externalId: "999", sourceUrl: "https://next.dnd.su/bestiary/999-ancient-red-dragon",
    finalUrl: "https://next.dnd.su/bestiary/999-ancient-red-dragon", redirectChain: [], fetchedAt: "2026-08-07T10:00:00.000Z",
    sha256: "a".repeat(64), byteLength: 4096, parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${"a".repeat(64)}.html`, kind: "detail",
    normalized: parseNextDndDetail(html, "bestiary", "999"), indexMetadata,
    indexSource: { url: "https://next.dnd.su/bestiary/", fingerprintSha256: "b".repeat(64), rawBlobPath: `blobs/${"b".repeat(64)}.html`, fetchedAt: "2026-08-07T09:59:00.000Z", cardFingerprintSha256: nextDndCardFingerprint(indexMetadata) },
  } as const;
}
