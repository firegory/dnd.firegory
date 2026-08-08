import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyCandidatePublication, projectSnapshotFeatureCandidate, projectSnapshotHierarchyCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { parseDeterministicChunk } from "../../src/server/compendium/candidate-parsers.ts";
import { EXTRACTION_PARSER_VERSION, EXTRACTION_PROMPT_VERSION } from "../../src/server/compendium/candidate-schema.ts";
import { validateClassProjection, validateSpeciesProjection } from "../../src/server/compendium/hierarchy-schema.ts";
import { canonicalEntryId, collectorCandidateKey } from "../../src/server/compendium/identity.ts";
import { nextDndImportBatch } from "../../src/server/compendium/next-dnd/import-adapter.ts";
import { featureCandidates, hierarchyCandidate } from "../../src/server/compendium/next-dnd/hierarchy-import.ts";
import { OptionReadService } from "../../src/server/compendium/option-read-service.ts";
import { projectCanonicalRevisions, type IndexedEntryProjection } from "../../src/server/content-index/projection.ts";
import { nfsIndexEntryRow } from "../../src/server/content-index/sync.ts";
import { createCanonicalRevision, type ContentSource } from "../../src/server/content-storage/repository.ts";
import {
  COMPLETE_CLASS, REPRESENTATIVE_SPECIES, REPRESENTATIVE_SUBCLASS, REPRESENTATIVE_VARIANT,
  completeClassPdfText, hierarchyDetailsFixture,
} from "../fixtures/character-options.mts";

const sourceId="11111111-1111-4111-8111-111111111111";
const fileId="22222222-2222-4222-8222-222222222222";
const source={schemaVersion:1,kind:"source",sourceId:"character-options",title:"Character Options",category:"core_rules",edition:"5.5e",language:"en",accessTier:"open",shared:false,ownerUserId:null,publication:{code:"PHB",title:"Player's Handbook",publisher:"Fixture",releaseYear:2024,revision:"2024",sourcePriority:100,canonicalBookId:"phb-2024"},files:[{fileId,path:`sources/character-options/files/${fileId}.snapshot`,mediaType:"application/x-next-dnd-snapshot",contentHash:`sha256:${"d".repeat(64)}`}]} as const;

test("representative hierarchy validates completeness, overrides, and reserved anchors",()=>{
  assert.deepEqual(validateClassProjection(COMPLETE_CLASS).progressionRows.map((row)=>row.level),Array.from({length:20},(_,index)=>index+1));
  assert.equal(validateClassProjection(REPRESENTATIVE_SUBCLASS).parentClassIds[0],"class-17");
  assert.equal(validateSpeciesProjection(REPRESENTATIVE_SPECIES).kind,"species");
  assert.equal(validateSpeciesProjection(REPRESENTATIVE_VARIANT).traits[0].overrides,"resourceful");
  assert.throws(()=>validateClassProjection({...COMPLETE_CLASS,progressionRows:[]}),/1 through 20/);
  assert.throws(()=>validateClassProjection({...COMPLETE_CLASS,features:[{...COMPLETE_CLASS.features[0],anchor:"progression"}]}),/reserved page anchor/);
  assert.throws(()=>validateClassProjection({...COMPLETE_CLASS,features:[{...COMPLETE_CLASS.features[0],anchor:"level-20"}]}),/reserved page anchor/);
  assert.throws(()=>validateSpeciesProjection({...REPRESENTATIVE_VARIANT,traits:[{...REPRESENTATIVE_VARIANT.traits[0],anchor:"section-rules"}]}),/reserved page anchor/);
  assert.throws(()=>validateSpeciesProjection({...REPRESENTATIVE_VARIANT,traits:[{...REPRESENTATIVE_VARIANT.traits[0],anchor:"citation-forged"}]}),/reserved page anchor/);
});

test("PDF parser only classifies a complete cited 1-20 class as publishable",()=>{
  const text=completeClassPdfText();const chunk={id:"33333333-3333-4333-8333-333333333333",chunkIndex:0,pageNumber:10,sectionHeading:"Fighter",quoteText:text};
  const [parsed]=parseDeterministicChunk(chunk,"en");assert.equal((parsed.wire.attributes.progressionRows as unknown[]).length,20);
  const envelope={...parsed.wire,schemaVersion:1,provenance:{sourceId,fileId,generationId:"44444444-4444-4444-8444-444444444444",edition:"5.5e",language:"en",accessTier:"open",shared:false,ownerUserId:null},extraction:{method:parsed.method,parserVersion:EXTRACTION_PARSER_VERSION,promptVersion:EXTRACTION_PROMPT_VERSION,modelVersion:"deterministic"},review:{status:"ready",reasons:[]}};
  assert.equal(classifyCandidatePublication(envelope,{candidateKey:parsed.wire.candidateKey,entryType:"class",sourceId,fileId,generationId:envelope.provenance.generationId,edition:"5.5e",language:"en",accessTier:"open",shared:false,ownerUserId:null,chunk}).publicationCapability,"publishable");
  const incomplete={...envelope,attributes:{...envelope.attributes,progressionRows:[]}};
  assert.equal(classifyCandidatePublication(incomplete,{candidateKey:parsed.wire.candidateKey,entryType:"class",sourceId,fileId,generationId:envelope.provenance.generationId,edition:"5.5e",language:"en",accessTier:"open",shared:false,ownerUserId:null,chunk}).publicationCapability,"requires_extraction");
});

test("collector and canonical IDs share external identity with parent references",()=>{
  const batch=collectorBatch();
  assert.deepEqual(batch.candidates.map((candidate)=>candidate.candidateKey),["17","133","1","2"]);
  assert.equal(collectorCandidateKey("class","class","17"),"17");
  assert.equal(canonicalEntryId("class",batch.candidates[0].candidateKey!),"class-17");
  const subclass=batch.candidates[1].content as {attributes:{parentClassIds:string[]}};
  const variant=batch.candidates[3].content as {attributes:{parentSpeciesIds:string[]}};
  assert.deepEqual(subclass.attributes.parentClassIds,["class-17"]);
  assert.deepEqual(variant.attributes.parentSpeciesIds,["species-1"]);
});

test("derived class features remain publishable with exact class snapshot evidence",()=>{
  const detail=hierarchyDetailsFixture()[0],hierarchy=hierarchyCandidate(detail),candidate=featureCandidates(detail)[0];
  const evidence={sourceUrl:detail.sourceUrl,fingerprintSha256:detail.sha256,rawBlobPath:detail.blobPath,fetchedAt:detail.fetchedAt,fileChecksumSha256:"d".repeat(64),indexUrl:detail.indexSource.url,indexFingerprintSha256:detail.indexSource.fingerprintSha256,rawIndexBlobPath:detail.indexSource.rawBlobPath,indexFetchedAt:detail.indexSource.fetchedAt,indexCardFingerprintSha256:detail.indexSource.cardFingerprintSha256,metadataEvidenceText:hierarchy.sourceVersion.index.metadataEvidenceText};
  assert.equal(classifyCandidatePublication(candidate,{candidateKey:candidate.externalId,entryType:"feature",sourceId,fileId,generationId:null,edition:"5.5e",language:"en",accessTier:"open",shared:false,ownerUserId:null,chunk:null,snapshotEvidence:evidence}).publicationCapability,"publishable");
  const revision=projectSnapshotFeatureCandidate(candidate,{candidateKey:candidate.externalId,createdAt:detail.fetchedAt,source,fileId,evidence});
  assert.equal(revision.entryId,"feature-second-wind");assert.equal(revision.entry.entryType,"classFeature");
});

test("NFS projection requires exact relation targets and validates graph and inherited overrides",()=>{
  const revisions=canonicalHierarchy(source);
  const projections=projectAll("fixture",source,revisions);
  const fighter=projections.find((entry)=>entry.entryId==="class-17")!;
  assert.deepEqual(fighter.relations.map((relation)=>[relation.relationKind,relation.targetEntryId]),[["feature","feature-second-wind"],["feature","feature-action-surge"],["cross_link","species-1"]]);
  assert.equal(fighter.relations.every((relation)=>relation.sourceId===relation.targetSourceId&&relation.edition==="5.5e"&&relation.language==="en"&&relation.targetLifecycle==="active"),true);
  const override=projections.find((entry)=>entry.entryId==="species-2")!.relations.find((relation)=>relation.relationKind==="trait_override")!;
  assert.deepEqual({target:override.targetEntryId,sourceAnchor:override.sourceAnchor,anchor:override.anchor},{target:"species-1",sourceAnchor:"fleet",anchor:"resourceful"});

  assert.throws(()=>projectAll("missing-target",source,revisions.filter((revision)=>revision.entryId!=="species-1")),/exact (?:target|source snapshot)/);
  assert.throws(()=>projectAll("cycle",source,replaceProjection(revisions,"class-17",{...COMPLETE_CLASS,kind:"subclass",parentClassIds:["class-133"]})),/cycle/i);
  assert.throws(()=>projectAll("bad-kind",source,replaceProjection(revisions,"class-133",{...REPRESENTATIVE_SUBCLASS,parentClassIds:["species-1"] as never})),/wrong kind|invalid canonical ID/i);
  assert.throws(()=>projectAll("bad-override",source,replaceProjection(revisions,"species-2",{...REPRESENTATIVE_VARIANT,traits:[{...REPRESENTATIVE_VARIANT.traits[0],overrides:"missing-trait"}]})),/does not resolve/);
  const derivedParent=[...revisions,duplicateProjection(revisions,"class-17","class-18",{...REPRESENTATIVE_SUBCLASS,parentClassIds:["class-17"]})];
  assert.throws(()=>projectAll("derived-parent",source,replaceProjection(derivedParent,"class-133",{...REPRESENTATIVE_SUBCLASS,parentClassIds:["class-18"]})),/direct base option/);
});

test("same canonical IDs in two sources keep exact NFS relations and reader navigation isolated",async()=>{
  const sourceB={...source,sourceId:"character-options-errata",title:"Character Options Errata",publication:{...source.publication,code:"ERR",revision:"2025"}} as ContentSource;
  const a=projectAll("repo-a",source,canonicalHierarchy(source));const b=projectAll("repo-b",sourceB,canonicalHierarchy(sourceB));
  const fighterA=a.find((entry)=>entry.entryId==="class-17")!,fighterB=b.find((entry)=>entry.entryId==="class-17")!;
  assert.notEqual(fighterA.sourceUuid,fighterB.sourceUuid);assert.notEqual(fighterA.revisionId,fighterB.revisionId);
  assert.equal(fighterA.relations.every((relation)=>relation.targetSourceId===fighterA.sourceUuid),true);
  assert.equal(fighterB.relations.every((relation)=>relation.targetSourceId===fighterB.sourceUuid),true);
  const statements:string[]=[];const row=readerRow("repo-a",fighterA,source);
  const detail=await new OptionReadService({async query(sql:string){statements.push(sql);return{rows:[row]};}}).get("class",{role:"user"},fighterA.entryId);
  assert.deepEqual(detail.accessibleCrossLinks,["species-1"]);assert.equal(detail.relations.every((relation)=>relation.targetSourceId===fighterA.sourceUuid),true);
  assert.match(statements[0],/target\.revision_id=relation\.target_revision_id/);assert.match(statements[0],/target\.source_id=relation\.target_source_id/);
  assert.match(statements[0],/target\.file_id=relation\.target_file_id/);assert.match(statements[0],/relation\.source_file_id=option_version\.file_id/);
  const noRelations=await new OptionReadService({async query(){return{rows:[{...row,relations:[]}]};}}).get("class",{role:"user"},fighterA.entryId);
  assert.deepEqual(noRelations.crossLinks,[]);assert.deepEqual(noRelations.features,[]);
  const syncSource=await readFile("src/server/content-index/sync.ts","utf8");
  assert.match(syncSource,/DELETE FROM nfs_index_option_relations[\s\S]*source_entry_id=ANY/);
  assert.match(syncSource,/INSERT INTO nfs_index_option_relations[\s\S]*source_revision_id[\s\S]*target_revision_id[\s\S]*target_source_id/);
});

test("hierarchy UI retains exact-version links, responsive print tables, and deep anchors",async()=>{
  const [detail,css,list,editor]=await Promise.all([readFile("src/components/compendium/option-detail.tsx","utf8"),readFile("src/app/globals.css","utf8"),readFile("src/components/compendium/option-list.tsx","utf8"),readFile("src/app/admin/compendium/entries/editor-client.tsx","utf8")]);
  assert.match(list,/Классы и подклассы.*Classes and subclasses/s);assert.match(detail,/targetSourceId/);assert.match(detail,/targetRevisionId/);
  assert.match(detail,/id={`level-\$\{row\.level\}`}/);assert.match(detail,/id={feature\.anchor}/);assert.match(detail,/relationKind==="trait_override"/);
  assert.match(detail,/targetRevisionId/);assert.match(detail,/#\$\{resolved\.anchor\}/);
  assert.match(css,/@media print[\s\S]*\.progression-table thead[\s\S]*table-header-group/);assert.match(css,/@media \(max-width: 39\.999rem\)[\s\S]*\.option-filters,[\s\S]*grid-template-columns: 1fr/);assert.match(editor,/Progression levels 1-20 \(JSON\)/);
});

function collectorBatch(){const details=hierarchyDetailsFixture();return nextDndImportBatch({schemaVersion:2,parserVersion:"next-dnd-2024-v3",status:"complete",collectedAt:details[0].fetchedAt,robots:{userAgent:"fixture",snapshot:{} as never,rules:[],evaluations:[]},categories:[{requestedCategory:"class",discoveredCategory:"class",entryCount:2,index:{} as never,details:details.slice(0,2)},{requestedCategory:"species",discoveredCategory:"species",entryCount:2,index:{} as never,details:details.slice(2)}],parserFailures:[],diagnostics:[]});}

function canonicalHierarchy(contentSource:ContentSource){const details=hierarchyDetailsFixture();const batch=collectorBatch();const hierarchy=batch.candidates.map((record,index)=>{const occurrence=batch.occurrences[index];const evidence={sourceUrl:occurrence.locator,fingerprintSha256:occurrence.fingerprintSha256,rawBlobPath:occurrence.rawBlobPath!,fetchedAt:occurrence.sourceFetchedAt!,fileChecksumSha256:"d".repeat(64),indexUrl:occurrence.indexLocator!,indexFingerprintSha256:occurrence.indexFingerprintSha256!,rawIndexBlobPath:occurrence.rawIndexBlobPath!,indexFetchedAt:occurrence.indexSourceFetchedAt!,indexCardFingerprintSha256:occurrence.indexCardFingerprintSha256!,metadataEvidenceText:occurrence.metadataEvidenceText!};const entryType=index<2?"class":"species";return projectSnapshotHierarchyCandidate(record.content,{candidateKey:record.candidateKey!,entryType,createdAt:details[index].fetchedAt,source:contentSource,fileId,evidence});});return[...hierarchy,featureRevision(contentSource,"second-wind","Second Wind"),featureRevision(contentSource,"action-surge","Action Surge"),featureRevision(contentSource,"improved-critical","Improved Critical")];}

function featureRevision(contentSource:ContentSource,key:string,title:string){const body=`${title} feature rules.`;return createCanonicalRevision({schemaVersion:1,kind:"canonicalRevision",entryId:`feature-${key}`,createdAt:"2026-08-07T12:00:00.000Z",source:contentSource,entry:{entryType:"classFeature",name:title,aliases:[],typedFields:[{key:"level",label:"level",type:"number",value:1},{key:"feature-kind",label:"featureKind",type:"string",value:"class"}]},text:{plain:body,sections:[{sectionId:"feature-rules",heading:title,text:body,startOffset:0,endOffset:body.length}]},citations:[{citationId:"feature-body",sourceId:contentSource.sourceId,fileId,page:null,section:title,quote:body,startOffset:null,endOffset:null}]});}

function projectAll(repositoryId:string,contentSource:ContentSource,revisions:ReturnType<typeof canonicalHierarchy>){return projectCanonicalRevisions(repositoryId,revisions,[{sourceId:contentSource.sourceId,fileId,path:contentSource.files[0].path,mediaType:contentSource.files[0].mediaType,contentHash:contentSource.files[0].contentHash,byteSize:4096}]);}

function replaceProjection(revisions:ReturnType<typeof canonicalHierarchy>,entryId:string,projection:unknown){return revisions.map((revision)=>{if(revision.entryId!==entryId)return revision;const {revisionId:currentRevisionId,contentHash,...input}=revision;void currentRevisionId;void contentHash;return createCanonicalRevision({...input,entry:{...revision.entry,typedFields:Object.entries(projection as Record<string,unknown>).map(([key,value])=>typedField(key,value)).filter(Boolean)}} as never);});}
function duplicateProjection(revisions:ReturnType<typeof canonicalHierarchy>,templateId:string,entryId:string,projection:unknown){const revision=revisions.find((item)=>item.entryId===templateId)!;const {revisionId:currentRevisionId,contentHash,...input}=revision;void currentRevisionId;void contentHash;return createCanonicalRevision({...input,entryId,entry:{...revision.entry,name:entryId,typedFields:Object.entries(projection as Record<string,unknown>).map(([key,value])=>typedField(key,value)).filter(Boolean)}} as never);}
function typedField(key:string,value:unknown){if(value===null)return null;const stable=key.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();const encoded=["progressionColumns","progressionRows","features","traits"].includes(key)&&Array.isArray(value)?value.map((item)=>JSON.stringify(item)):value;return{key:stable,label:key,type:Array.isArray(encoded)?"stringList":typeof encoded==="number"?"number":typeof encoded==="boolean"?"boolean":"string",value:encoded};}

function readerRow(repositoryId:string,entry:IndexedEntryProjection,contentSource:ContentSource){const synced=nfsIndexEntryRow(repositoryId,entry);return{...synced,mime_type:contentSource.files[0].mediaType,source_title:contentSource.title,edition:contentSource.edition,language:contentSource.language,publication_code:contentSource.publication.code,publication_revision:contentSource.publication.revision,source_priority:contentSource.publication.sourcePriority,source_versions:[{sourceId:synced.source_id,title:contentSource.title,code:contentSource.publication.code,revision:contentSource.publication.revision,revisionId:synced.revision_id}],relations:entry.relations.map((relation)=>({targetId:relation.targetEntryId,targetRevisionId:relation.targetRevisionId,targetSourceId:relation.targetSourceId,relationKind:relation.relationKind,targetKind:relation.targetKind,sourceAnchor:relation.sourceAnchor,anchor:relation.anchor}))};}
