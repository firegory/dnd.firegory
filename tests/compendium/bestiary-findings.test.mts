import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyCandidatePublication } from "../../src/server/compendium/candidate-publication.ts";
import { validateCandidateWire } from "../../src/server/compendium/candidate-schema.ts";
import { CreatureReadService } from "../../src/server/compendium/creature-read-service.ts";
import { normalizeChallengeRating } from "../../src/server/compendium/creature-schema.ts";
import { buildEditorCanonicalRevision, camelProjection, EntryEditorError } from "../../src/server/compendium/entry-editor.ts";
import { creatureCandidate, creatureMetadataEvidence } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import { ancientDragonDetail } from "../fixtures/next-dnd/bestiary.mts";

const detail = ancientDragonDetail();
type MutableCreatureAttributes = {
  abilities: Record<string,number>; saves: Record<string,number>; skills: Record<string,number>;
  speeds: Array<{distance:number}>; armorClass: Array<{value:number}>; hitPoints: {average:number};
  challengeRating: {numerator:number;denominator:number}; actions: Array<{name:string;text:string}>;
};
const evidence = { sourceUrl:detail.sourceUrl,fingerprintSha256:detail.sha256,rawBlobPath:detail.blobPath,fetchedAt:detail.fetchedAt,fileChecksumSha256:"d".repeat(64),indexUrl:detail.indexSource.url,indexFingerprintSha256:detail.indexSource.fingerprintSha256,rawIndexBlobPath:detail.indexSource.rawBlobPath,indexFetchedAt:detail.indexSource.fetchedAt,indexCardFingerprintSha256:detail.indexSource.cardFingerprintSha256,metadataEvidenceText:creatureMetadataEvidence(detail.indexMetadata) };
const context = { candidateKey:"bestiary-999",entryType:"creature",sourceId:"11111111-1111-4111-8111-111111111111",fileId:"22222222-2222-4222-8222-222222222222",generationId:null,edition:"5.5e",language:"ru",accessTier:"open",shared:false,ownerUserId:null,chunk:null,snapshotEvidence:evidence } as const;

test("realistic HTML preserves ordinary trait and action boundaries", () => {
  assert.match(detail.normalized.contentText, /Traits\nLegendary Resistance\./);
  assert.doesNotMatch(detail.normalized.contentText, /;|\|/);
  const candidate=creatureCandidate(detail as never);
  assert.deepEqual(candidate.attributes.traits.map((block)=>block.name),["Legendary Resistance","Fire Aura"]);
  assert.deepEqual(candidate.attributes.actions.map((block)=>block.name),["Multiattack","Fire Breath"]);
});

test("collector repair cannot replace unsupported values or immutable citations", () => {
  const candidate=creatureCandidate(detail as never);
  const valueTamper=structuredClone(candidate);
  valueTamper.attributes.armorClass[0].value=23;
  assert.equal(classifyCandidatePublication(valueTamper,context).publicationCapability,"requires_extraction");
  const citationTamper=structuredClone(candidate);
  citationTamper.citations[2].quote=candidate.body;
  assert.equal(classifyCandidatePublication(citationTamper,context).publicationCapability,"requires_extraction");
  const blockTamper=structuredClone(candidate);
  blockTamper.attributes.actions[0].text="The dragon makes nine attacks.";
  assert.equal(classifyCandidatePublication(blockTamper,context).publicationCapability,"requires_extraction");
});

test("collector and PDF evidence bind creature keys to their own values", () => {
  const candidate=creatureCandidate(detail as never);
  const mutations: Array<(attributes: MutableCreatureAttributes)=>void> = [
    (attributes)=>{[attributes.abilities.str,attributes.abilities.dex]=[attributes.abilities.dex,attributes.abilities.str];},
    (attributes)=>{[attributes.saves.DEX,attributes.saves.CON]=[attributes.saves.CON,attributes.saves.DEX];},
    (attributes)=>{[attributes.skills.Perception,attributes.skills.Stealth]=[attributes.skills.Stealth,attributes.skills.Perception];},
    (attributes)=>{[attributes.speeds[0].distance,attributes.speeds[2].distance]=[attributes.speeds[2].distance,attributes.speeds[0].distance];},
    (attributes)=>{attributes.armorClass[0].value=24;},
    (attributes)=>{attributes.hitPoints.average=22;},
    (attributes)=>{attributes.challengeRating={numerator:22,denominator:1};},
    (attributes)=>{[attributes.actions[0].text,attributes.actions[1].text]=[attributes.actions[1].text,attributes.actions[0].text];},
  ];
  const pdfText=`Ancient Red Dragon\n${candidate.body}`;
  const pdfCitation=(fieldPath:string,quote:string)=>{const start=pdfText.indexOf(quote);assert.ok(start>=0);const quoteSpanStart=Array.from(pdfText.slice(0,start)).length;return {fieldPath,chunkId:"99999999-9999-4999-8999-999999999999",quote,quoteSpanStart,quoteSpanEnd:quoteSpanStart+Array.from(quote).length};};
  const pdf={entryType:"creature",candidateKey:"ancient-red-dragon",title:"Ancient Red Dragon",body:candidate.body,attributes:candidate.attributes,citations:[
    pdfCitation("$.entryType","Gargantuan dragon, chaotic evil."),pdfCitation("$.candidateKey","Ancient Red Dragon"),pdfCitation("$.title","Ancient Red Dragon"),pdfCitation("$.body",candidate.body),
    ...candidate.citations.filter((citation)=>citation.fieldPath.startsWith("$.attributes.")).map((citation)=>pdfCitation(citation.fieldPath,citation.quote)),
  ]} as const;
  const chunk={id:"99999999-9999-4999-8999-999999999999",chunkIndex:0,pageNumber:1,sectionHeading:"Ancient Red Dragon",quoteText:pdfText};
  assert.equal(validateCandidateWire(pdf,[chunk]),pdf);
  for(const mutate of mutations){
    const collectorTamper=structuredClone(candidate) as unknown as {attributes:MutableCreatureAttributes};mutate(collectorTamper.attributes);
    assert.equal(classifyCandidatePublication(collectorTamper,context).publicationCapability,"requires_extraction");
    const pdfTamper=structuredClone(pdf) as unknown as {attributes:MutableCreatureAttributes};mutate(pdfTamper.attributes);
    assert.throws(()=>validateCandidateWire(pdfTamper,[chunk]),/(?:value-supporting evidence|type schema)/i);
  }
});

test("CR rejects unreduced fractions and keyset ties include title and ID", async () => {
  assert.throws(()=>normalizeChallengeRating("2/4"),/Challenge rating/);
  const row=creatureRow(); const statements:Array<{sql:string;values:readonly unknown[]}>=[];
  const first=new CreatureReadService({async query(sql:string,values:readonly unknown[]=[]){statements.push({sql,values});return sql.includes("count(*)")?{rows:[{count:"2"}]}:{rows:[row,{...row,entry_id:"creature-b",revision_id:`rev-${"c".repeat(64)}`}]};}});
  const page=await first.list({role:"user"},{limit:1}); assert.ok(page.nextCursor);
  const secondStatements:Array<{sql:string;values:readonly unknown[]}>=[];
  await new CreatureReadService({async query(sql:string,values:readonly unknown[]=[]){secondStatements.push({sql,values});return sql.includes("count(*)")?{rows:[{count:"2"}]}:{rows:[row]};}}).list({role:"user"},{limit:1,cursor:page.nextCursor!});
  assert.match(secondStatements[0].sql,/creature\.cr_value,creature\.sort_title COLLATE "C",creature\.entry_id/);
  assert.deepEqual(secondStatements[0].values.slice(-4,-1),["1","dragon","creature-a"]);
});

test("multi-source versions remain inside the same RBAC and selection boundary", async () => {
  const statements:string[]=[]; const row=creatureRow();
  await new CreatureReadService({async query(sql:string){statements.push(sql);return sql.includes("count(*)")?{rows:[{count:"1"}]}:{rows:[row]};}}).list({role:"premium",userId:"33333333-3333-4333-8333-333333333333"},{edition:"5.5e",language:"ru",category:"official_supplement"});
  assert.match(statements[0],/accessible_creature_versions AS MATERIALIZED/);
  assert.match(statements[0],/s\.owner_user_id/);
  assert.match(statements[0],/s\.edition/); assert.match(statements[0],/s\.language/); assert.match(statements[0],/s\.category/);
  assert.match(statements[0],/FROM accessible_creature_versions source_version/);
});

test("legacy editor projections retain null alignment and cannot publish", async () => {
  const editor=await readFile("src/app/admin/compendium/entries/editor-client.tsx","utf8");
  assert.match(editor,/field\.key==="alignment"[\s\S]*value\.alignment=.*:null/);
  const entry={entryType:"creature"}; const revision={projection:{projectionStatus:"legacy_incomplete"}};
  await assert.rejects(buildEditorCanonicalRevision({query(){throw new Error("database must not be read");}} as never,{userId:"admin",role:"admin"},entry as never,revision as never),(error:unknown)=>error instanceof EntryEditorError&&error.status===409);
  assert.deepEqual(camelProjection({projection_status:"legacy_incomplete",size:"medium",creature_type:"beast",alignment:null,armor_class:12,hit_points:10,challenge_rating:0.25,speed:"30 ft., fly 60 ft.",extension_data:{}}),{
    projectionStatus:"legacy_incomplete",size:"medium",creatureType:"beast",alignment:null,challengeRating:0.25,extensionData:{},armorClass:[{value:12}],hitPoints:{average:10},speeds:[{mode:"walk",distance:30,unit:"ft"},{mode:"fly",distance:60,unit:"ft"}],
  });
});

test("detail links retain filters and print keeps source and citation text", async () => {
  const [list,page,detail,css]=await Promise.all([readFile("src/app/bestiary/bestiary-list.tsx","utf8"),readFile("src/app/bestiary/[identifier]/page.tsx","utf8"),readFile("src/app/bestiary/[identifier]/bestiary-detail.tsx","utf8"),readFile("src/app/globals.css","utf8")]);
  assert.match(list,/detailQuery/); assert.match(page,/parseSelection\(url\)/); assert.match(page,/returnHref/);
  assert.match(detail,/creature\.sourceVersion/); assert.match(detail,/sourceDetailUrl/); assert.match(detail,/print-source-text/);
  assert.match(css,/@media print[\s\S]*\.bestiary-citations,[\s\S]*display: block/);
});

function creatureRow(){const candidate=creatureCandidate(detail as never);return {entry_id:"creature-a",revision_id:`rev-${"b".repeat(64)}`,name:"Dragon",aliases:[],typed_fields:Object.entries(candidate.attributes).map(([key,value])=>({key:key.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),label:key,type:typeof value==="string"?"string":Array.isArray(value)&&value.every((item)=>typeof item==="string")?"stringList":"json",value})),plain_text:candidate.body,canonical_payload:{citations:[]},source_id:"11111111-1111-4111-8111-111111111111",file_id:"22222222-2222-4222-8222-222222222222",mime_type:"text/html",source_title:"Bestiary",edition:"5.5e",language:"ru",publication_code:"MM",publication_revision:"2024",source_priority:10,sort_title:"dragon",cr_value:"1",source_versions:[]};}
