import assert from "node:assert/strict";
import test from "node:test";

import { buildEditorCanonicalRevision, editorCanonicalEntryId, editorSubmissionErrorStatus, EntryEditorService, recordEditorPublicationOutcome } from "../../src/server/compendium/entry-editor.ts";
import { CompendiumService } from "../../src/server/compendium/service.ts";
import { PublicationEnqueueAmbiguousError } from "../../src/server/content-storage/publication-command.ts";

const versionId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
const token = `rev-${"a".repeat(64)}`;
const admin = { userId: "admin-user", role: "admin" } as const;

test("editor canonical identities match the type-qualified #76 publication contract", () => {
  assert.equal(editorCanonicalEntryId("spell", "shield"), "spell-shield");
  assert.notEqual(editorCanonicalEntryId("equipment", "shield"), editorCanonicalEntryId("spell", "shield"));
});

test("publication rejects an exact stale canonical CAS token before persisting a command", async () => {
  let transactions = 0;
  const service = new EntryEditorService(
    (async () => { transactions++; throw new Error("must not transact"); }) as never,
    {} as never,
    {} as never,
    async () => token,
  );
  await assert.rejects(service.requestPublication(admin, versionId, { action: "publish", revisionId, expectedActiveRevisionId: null, reason: "Publish." }), (error: unknown) => error instanceof Error && /changed/.test(error.message) && (error as { status?: number }).status === 409);
  assert.equal(transactions, 0);
});

test("correction CAS rejects before inserting a revision", async () => {
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({ async query(sql: string) {
    statements.push(sql);
    if (sql.includes("FROM compendium_versions WHERE")) return { rows: [{ entry_type:"feature",lifecycle:"published",source_id:versionId,file_id:revisionId,active_revision_id:revisionId,editor_head_revision_id:revisionId }] } as never;
    return { rows: [] } as never;
  }}));
  await assert.rejects(service.createRevision(versionId, { title:"Changed",body:"Text",projection:{type:"feature",level:1,featureKind:"class"},basedOnRevisionId:versionId,actor:"admin",reason:"Correction" }), /changed after this editor was opened/);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO compendium_revisions")), false);
});

test("published corrections atomically advance editor head and reject a concurrent stale base", async () => {
  let editorHead = revisionId;
  let inserted = 0;
  const nextRevision = "10000000-0000-4000-8000-000000000003";
  const statements: string[] = [];
  const service = new CompendiumService(async (callback) => callback({ async query(sql:string, values:readonly unknown[]=[]){
    statements.push(sql);
    if(sql.includes("FROM compendium_versions WHERE")) return {rows:[{entry_type:"feature",lifecycle:"published",source_id:versionId,file_id:revisionId,active_revision_id:revisionId,editor_head_revision_id:editorHead}]};
    if(sql.includes("coalesce(max(revision_number)")) return {rows:[{revision_number:2}]};
    if(sql.includes("INSERT INTO compendium_revisions")){inserted++;return {rows:[{id:nextRevision}]};}
    if(sql.includes("SET editor_head_revision_id")){editorHead=String(values[1]);return {rows:[],rowCount:1};}
    return {rows:[],rowCount:1};
  }} as never));
  const correction={title:"Correction",body:"Text",projection:{type:"feature",level:1,featureKind:"class"} as const,basedOnRevisionId:revisionId,actor:"admin",reason:"Fix"};
  assert.equal(await service.createRevision(versionId,correction),nextRevision);
  await assert.rejects(service.createRevision(versionId,correction),/changed after this editor was opened/);
  assert.equal(inserted,1);
  assert.equal(editorHead,nextRevision);
  assert.equal(statements.some((sql)=>sql.includes("SET active_revision_id") && sql.includes("lifecycle = 'draft'")),false);
});

const sourceRow={id:versionId,canonical_source_id:"source-book",title:"Source Book",category:"official_supplement",edition:"5e",language:"en",access_tier:"premium",shared:true,owner_user_id:null,publication_code:"SB",publication_title:"Source Book",publisher:"Publisher",release_year:2020,publication_revision:"Second",external_origin_url:"https://example.com/books/source",external_origin_id:"source-2",attribution:"Used with permission",source_priority:7,canonical_book_id:"source-book",license:"License",metadata:{},created_by_user_id:null,created_at:"2026-01-01T00:00:00.000Z",updated_at:"2026-01-01T00:00:00.000Z",deleted_at:null};
const fileRows=[revisionId,"10000000-0000-4000-8000-000000000004"].map((id,index)=>({id,source_id:versionId,original_filename:`book-${index}.pdf`,mime_type:"application/pdf",checksum_sha256:String(index+1).repeat(64),byte_size:100,storage_path:`/storage/${id}.pdf`,processed_artifacts_root:null,uploaded_by_user_id:null,created_at:`2026-01-0${index+1}T00:00:00.000Z`,deleted_at:null}));
const editorEntry={versionId,entryId:versionId,canonicalKey:"shield",entryType:"feature",edition:"5e",language:"en",sourceId:versionId,fileId:revisionId,slug:"shield",aliases:[],activeRevisionId:revisionId,editorHeadRevisionId:revisionId,versionLifecycle:"published",canonicalRevisionId:null,publicationStatus:"unpublished",publicationAction:null,revisions:[],publications:[],audit:[]} as const;
const editorRevision={id:revisionId,number:1,title:"Shield",summary:null,body:"Body",blocks:[],projection:{level:1,featureKind:"class"},citations:[{quote:"Evidence",page:2,section:"Rules",generationStatus:"archived"}],basedOnRevisionId:null,actor:"admin",reason:"Create",createdAt:"2026-01-01T00:00:00.000Z",lifecycle:"draft"} as const;

test("canonical editor projection retains multi-file source metadata losslessly", async () => {
  const client={async query(sql:string){if(sql.includes("FROM sources"))return {rows:[sourceRow]};if(sql.includes("FROM files"))return {rows:fileRows};return {rows:[]};}};
  const revision=await buildEditorCanonicalRevision(client as never,admin,editorEntry as never,editorRevision as never);
  assert.equal(revision.source.files.length,2);
  assert.deepEqual(revision.source.publication.origin,{url:"https://example.com/books/source",id:"source-2"});
  assert.equal(revision.source.publication.attribution,"Used with permission");
  assert.equal(revision.source.accessTier,"premium");
  assert.equal(revision.source.shared,true);
});

test("canonical editor projection rejects pageless citations before publication persistence", async () => {
  const client={async query(sql:string){if(sql.includes("FROM sources"))return {rows:[sourceRow]};if(sql.includes("FROM files"))return {rows:fileRows};return {rows:[]};}};
  await assert.rejects(buildEditorCanonicalRevision(client as never,admin,editorEntry as never,{...editorRevision,citations:[{...editorRevision.citations[0],page:null}]} as never),/positive source page/);
});

test("only enqueue ambiguity maps to pending while validation errors stay synchronous", () => {
  assert.deepEqual(editorSubmissionErrorStatus(new PublicationEnqueueAmbiguousError(new Error("queue uncertain"))),{status:"pending"});
  assert.throws(()=>editorSubmissionErrorStatus(new TypeError("invalid canonical revision")),/invalid canonical revision/);
});

test("worker outcome activates an editor revision and records system audit", async () => {
  const statements: Array<{sql:string;values:readonly unknown[]}> = [];
  await recordEditorPublicationOutcome("editor-command", "completed", null, (async (callback) => callback({ async query(sql:string,values:readonly unknown[]=[]){
    statements.push({sql,values});
    if(sql.includes("UPDATE compendium_editor_publications")) return {rows:[{version_id:versionId,revision_id:revisionId,action:"publish",actor:"admin-user",reason:"Correction",canonical_revision_id:token}]};
    return {rows:[]};
  }})) as never);
  assert.ok(statements.some(({sql})=>sql.includes("UPDATE compendium_versions SET lifecycle='published'")));
  const audit=statements.find(({sql})=>sql.includes("INSERT INTO compendium_editor_audit"));
  assert.equal(audit?.values[3],"publication-worker");
  assert.match(String(audit?.values[5]),/initiatingActor/);
});

test("failed worker outcomes require a durable reason", async () => {
  await assert.rejects(recordEditorPublicationOutcome("editor-command", "failed", null, (async()=>{}) as never), /require an error/);
});
