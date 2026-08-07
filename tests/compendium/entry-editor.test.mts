import assert from "node:assert/strict";
import test from "node:test";

import { editorCanonicalEntryId, EntryEditorService, recordEditorPublicationOutcome } from "../../src/server/compendium/entry-editor.ts";
import { CompendiumService } from "../../src/server/compendium/service.ts";

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
    if (sql.includes("FROM compendium_versions WHERE")) return { rows: [{ entry_type:"feature",lifecycle:"published",source_id:versionId,file_id:revisionId,active_revision_id:revisionId }] } as never;
    return { rows: [] } as never;
  }}));
  await assert.rejects(service.createRevision(versionId, { title:"Changed",body:"Text",projection:{type:"feature",level:1,featureKind:"class"},basedOnRevisionId:versionId,actor:"admin",reason:"Correction" }), /changed after this editor was opened/);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO compendium_revisions")), false);
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
