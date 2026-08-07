import { nextDndCardFingerprint } from "../../../src/server/compendium/next-dnd/parser.ts";

export function ancientDragonDetail() {
  const indexMetadata = { title: "Древний красный дракон", title_en: "Ancient Red Dragon", size: "gargantuan", type: "dragon", challenge_rating: "24" };
  const text = "Ancient Red Dragon. Gargantuan dragon, chaotic evil. Armor Class 22 (natural armor) Hit Points 546 (28d20 + 252) Speed 40 ft., climb 40 ft., fly 80 ft. STR 30 (+10) DEX 10 (+0) CON 29 (+9) INT 18 (+4) WIS 15 (+2) CHA 23 (+6) Saving Throws DEX +7, CON +16, WIS +9, CHA +13 Skills Perception +16, Stealth +7 Damage Resistances fire Damage Immunities poison Condition Immunities frightened Senses blindsight 60 ft., darkvision 120 ft., passive Perception 26 Languages Common, Draconic Challenge Rating 24 (62,000 XP) Traits: Legendary Resistance. If the dragon fails a saving throw, it can choose to succeed instead.; Fire Aura. A creature that starts its turn nearby takes fire damage. Actions: Multiattack. The dragon makes three attacks.; Fire Breath. Each creature in a cone makes a Dexterity save. Bonus Actions: Wing Buffet. The dragon beats its wings. Reactions: Retaliatory Tail. The dragon makes one tail attack. Legendary Actions: Detect. The dragon makes a Wisdom check.; Tail Attack. The dragon makes a tail attack.";
  return {
    category: "bestiary", externalId: "999", sourceUrl: "https://next.dnd.su/bestiary/999-ancient-red-dragon",
    finalUrl: "https://next.dnd.su/bestiary/999-ancient-red-dragon", redirectChain: [], fetchedAt: "2026-08-07T10:00:00.000Z",
    sha256: "a".repeat(64), byteLength: 4096, parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${"a".repeat(64)}.html`, kind: "detail",
    normalized: { title: "Древний красный дракон", contentHtml: "<article>fixture</article>", contentText: text }, indexMetadata,
    indexSource: { url: "https://next.dnd.su/bestiary/", fingerprintSha256: "b".repeat(64), rawBlobPath: `blobs/${"b".repeat(64)}.html`, fetchedAt: "2026-08-07T09:59:00.000Z", cardFingerprintSha256: nextDndCardFingerprint(indexMetadata) },
  } as const;
}
