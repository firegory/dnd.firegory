import { createHash } from "node:crypto";
import type { ClassProjection, SpeciesProjection } from "../../src/server/compendium/hierarchy-schema.ts";
import type { SnapshotDetail } from "../../src/server/compendium/next-dnd/collector.ts";
import { nextDndCardFingerprint } from "../../src/server/compendium/next-dnd/parser.ts";

export const COMPLETE_CLASS: ClassProjection = {
  kind: "class", hitDie: 10, primaryAbility: "Strength or Dexterity", spellcastingAbility: null,
  parentClassIds: [],
  progressionColumns: [{ key: "proficiency-bonus", heading: "Proficiency Bonus" }, { key: "features", heading: "Features" }],
  progressionRows: Array.from({ length: 20 }, (_, index) => ({ level: index + 1, cells: { "proficiency-bonus": `+${2 + Math.floor(index / 4)}`, features: index === 0 ? "Fighting Style, Second Wind" : `Fighter feature ${index + 1}` } })),
  features: [{ canonicalId: "feature-second-wind", title: "Second Wind", body: "Regain Hit Points as a Bonus Action.", level: 1, anchor: "second-wind" }, { canonicalId: "feature-action-surge", title: "Action Surge", body: "Take one additional action.", level: 2, anchor: "action-surge" }],
  crossLinks: ["species-human"],
};

export const REPRESENTATIVE_SUBCLASS: ClassProjection = {
  kind: "subclass", hitDie: 10, primaryAbility: "Strength or Dexterity", spellcastingAbility: "Intelligence",
  parentClassIds: ["class-fighter"], progressionColumns: [], progressionRows: [],
  features: [{ canonicalId: "feature-improved-critical", title: "Improved Critical", body: "Your attacks score a Critical Hit on a roll of 19 or 20.", level: 3, anchor: "improved-critical" }], crossLinks: [],
};

export const REPRESENTATIVE_SPECIES: SpeciesProjection = {
  kind: "species", size: "medium", speed: 30, parentSpeciesIds: [], crossLinks: ["class-fighter"],
  traits: [{ key: "resourceful", title: "Resourceful", body: "You gain Heroic Inspiration after a Long Rest.", anchor: "resourceful", overrides: null }],
};

export const REPRESENTATIVE_VARIANT: SpeciesProjection = {
  kind: "variant", size: "medium", speed: 35, parentSpeciesIds: ["species-human"], crossLinks: [],
  traits: [{ key: "fleet", title: "Fleet", body: "Your Speed increases to 35 feet.", anchor: "fleet", overrides: "resourceful" }],
};

export function completeClassPdfText(): string {
  return ["Fighter", "Class", "Hit Die: d10", "Primary Ability: Strength or Dexterity", "Spellcasting Ability: none", "| Level | Proficiency Bonus | Features |", "| --- | --- | --- |",
    ...COMPLETE_CLASS.progressionRows.map((row) => `| ${row.level} | ${row.cells["proficiency-bonus"]} | ${row.cells.features} |`), "A Fighter masters every kind of weapon and armor."].join("\n");
}

export function hierarchyDetailsFixture(): SnapshotDetail[] {
  return [["class", "17", "Fighter", COMPLETE_CLASS], ["class", "133", "Champion", REPRESENTATIVE_SUBCLASS], ["species", "1", "Human", REPRESENTATIVE_SPECIES], ["species", "2", "Fleet Human", REPRESENTATIVE_VARIANT]].map(([category, externalId, title, attributes]) => {
    const metadata = { title_en: title, ...(attributes as object) }; const detailBody=`${title} rules with complete reviewed hierarchy.`;const sha256=createHash("sha256").update(detailBody).digest("hex");const indexHash=createHash("sha256").update(`${category}-index`).digest("hex");const sourceUrl=`https://next.dnd.su/${category}/${externalId}-${String(title).toLowerCase().replaceAll(" ","-")}`;
    return { kind:"detail",category,externalId,sourceUrl,finalUrl:sourceUrl,redirectChain:[],fetchedAt:"2026-08-07T12:00:00.000Z",sha256,byteLength:detailBody.length,parserVersion:"next-dnd-2024-v3",blobPath:`blobs/${sha256}.html`,normalized:{title,contentHtml:`<article>${title}</article>`,contentText:detailBody},indexMetadata:metadata,indexSource:{url:`https://next.dnd.su/${category}/`,fingerprintSha256:indexHash,rawBlobPath:`blobs/${indexHash}.html`,fetchedAt:"2026-08-07T11:59:00.000Z",cardFingerprintSha256:nextDndCardFingerprint(metadata)}} as SnapshotDetail;
  });
}
