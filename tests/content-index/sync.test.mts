import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { CanonicalRevision } from "../../src/server/content-storage/repository.ts";
import { assertCanonicalRevision, loadResolvedCanonicalRevisions } from "../../src/server/content-storage/validation.ts";
import {
  activateManagedGeneration,
  buildSyncPlan,
  bindNfsOptionRelation,
  expandAffectedSourceClosure,
  claimContentIndexRun,
  cleanupRemovedNfsFile,
  heartbeatContentIndexRun,
  reconcileManagedProjectionRows,
  resolveNfsManagedSourceAndFile,
  synchronizeContentIndex,
  upsertFileIndexRows,
} from "../../src/server/content-index/sync.ts";
import {
  CONTENT_INDEX_PROJECTOR_VERSION,
  deterministicUuid,
  entryProjectionHash,
  projectCanonicalRevisions,
  projectionHash,
} from "../../src/server/content-index/projection.ts";
import { mapSearchChunk } from "../../src/server/search/map-chunk.ts";
import { OptionReadService } from "../../src/server/compendium/option-read-service.ts";

const dataRoot = resolve("content-repository");

test("canonical projection deterministically rebuilds entries, pages, and chunks without embeddings", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const first = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const second = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].entryType, "action");
  assert.equal(first[0].pages[0].pageNumber, 72);
  assert.equal(first[0].pages[0].text, "When you take the Dash action, you gain extra movement for the current turn.");
  assert.equal(first[0].pages[0].citations[0].section, "Actions in Combat: Dash");
  assert.equal(first[0].file.byteSize, 144);
  assert.equal(first[0].chunks.length, 2);
  assert.equal(first[0].chunks[0].pageNumber, 72);
  assert.equal(first[0].chunks[0].sectionHeading, "Actions in Combat: Dash");
  assert.equal(first[0].chunks[0].quoteText, first[0].pages[0].citations[0].quote);
  assert.equal(first[0].chunks[0].textSpanStart, 0);
  assert.equal(first[0].chunks[0].textSpanEnd, 76);
  assert.equal(first[0].chunks[1].pageNumber, null);
  assert.equal("embedding" in first[0].chunks[0], false);
  assert.equal(first[0].chunks.map((chunk) => chunk.text).join(""), first[0].plainText);
});

test("affected source closure follows incoming exact-version relations", () => {
  const relation = (sourceEntryId: string, targetEntryId: string) => ({ sourceEntryId, targetEntryId }) as never;
  const affected = expandAffectedSourceClosure(new Set(["target"]), [
    { entryId: "target", fileUuid: "target-file", relations: [] },
    { entryId: "target-file-peer", fileUuid: "target-file", relations: [] },
    { entryId: "cross-file-source", fileUuid: "source-file", relations: [relation("cross-file-source", "target")] },
    { entryId: "source-file-peer", fileUuid: "source-file", relations: [] },
    { entryId: "incoming-source", fileUuid: "incoming-file", relations: [relation("incoming-source", "cross-file-source")] },
    { entryId: "unrelated", fileUuid: "unrelated-file", relations: [] },
  ] as never);
  assert.deepEqual([...affected], ["target", "target-file-peer", "cross-file-source", "source-file-peer", "incoming-source"]);
});

test("reused source and cross-file bindings commit exact hierarchy relation FKs",async()=>{
  const repositoryId="binding-fixture",projectedSourceId="11111111-1111-4111-8111-111111111111",boundSourceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const boundFileA="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",boundFileB="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const base=fakeBoundProjection("class-17","projected-file-a",projectedSourceId,"1",[]);
  const child=fakeBoundProjection("class-133","projected-file-a",projectedSourceId,"2",[fakeRelation("class-133","2","class-17","1",projectedSourceId,"parent")]);
  const species=fakeBoundProjection("species-1","projected-file-b",projectedSourceId,"3",[]);
  (base.relations as unknown[]).push(fakeRelation("class-17","1","species-1","3",projectedSourceId,"cross_link"));
  const bindingA={sourceId:boundSourceId,fileId:boundFileA,ownsSource:false,ownsFile:false},bindingB={sourceId:boundSourceId,fileId:boundFileB,ownsSource:false,ownsFile:false};
  const bindings=new Map([[base.entryId,{projection:base,binding:bindingA}],[child.entryId,{projection:child,binding:bindingA}],[species.entryId,{projection:species,binding:bindingB}]]) as never;
  const entries=new Set<string>(),relations:Array<readonly unknown[]>=[];
  const client={async query(text:string,params:readonly unknown[]=[]){
    if(text.includes("unmanaged_collision"))return result([{unmanaged_collision:false}]);
    if(text.includes("INSERT INTO nfs_index_entries")){entries.add(`${params[1]}:${params[2]}:${params[3]}:${params[11]}:${params[12]}`);return result([]);}
    if(text.includes("INSERT INTO nfs_index_option_relations")){relations.push(params);return result([]);}
    return result([]);
  }};
  await upsertFileIndexRows(client as never,repositoryId,[base,child] as never,bindingA,bindings);
  await upsertFileIndexRows(client as never,repositoryId,[species] as never,bindingB,bindings);
  assert.equal(relations.length,2);
  assert.deepEqual(relations.map((values)=>[values[1],values[3],values[4],values[5],values[7],values[8]]),[
    ["class-17",boundSourceId,boundFileA,"species-1",boundSourceId,boundFileB],
    ["class-133",boundSourceId,boundFileA,"class-17",boundSourceId,boundFileA],
  ]);
  for(const values of relations){assert.ok(entries.has(`${values[0]}:${values[1]}:${values[2]}:${values[3]}:${values[4]}`));assert.ok(entries.has(`${values[0]}:${values[5]}:${values[6]}:${values[7]}:${values[8]}`));}
  const childRelation=relations.find((values)=>values[1]==="class-133")!;let readerSql="";
  const detail=await new OptionReadService({async query(sql:string){readerSql=sql;return{rows:[{entry_id:"class-133",revision_id:child.revisionId,name:"Champion",typed_fields:classReaderFields(),aliases:[],plain_text:"Champion rules.",canonical_payload:{citations:[]},source_id:boundSourceId,file_id:boundFileA,mime_type:"text/plain",source_title:"Source",edition:"5.5e",language:"en",publication_code:"SRC",publication_revision:"2024",source_versions:[],relations:[{targetId:childRelation[5],targetRevisionId:childRelation[6],targetSourceId:childRelation[7],relationKind:"parent",targetKind:"class",sourceAnchor:"",anchor:null}]}]};}}).get("class",{role:"user"},"class-133");
  assert.deepEqual(detail.parentClassIds,["class-17"]);assert.equal(detail.relations[0].targetSourceId,boundSourceId);
  assert.match(readerSql,/target\.file_id=relation\.target_file_id/);assert.match(readerSql,/relation\.source_file_id=option_version\.file_id/);
});

test("hierarchy relation binding fails closed on missing, stale, or mismatched endpoints",()=>{
  const projectedSource="11111111-1111-4111-8111-111111111111",source=fakeBoundProjection("class-133","file-a",projectedSource,"2",[]),target=fakeBoundProjection("class-17","file-b",projectedSource,"1",[]);
  const relation=fakeRelation("class-133","2","class-17","1",projectedSource,"parent"),binding={sourceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",fileId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",ownsSource:false,ownsFile:false};
  const entries=new Map([[source.entryId,{projection:source,binding}],[target.entryId,{projection:target,binding:{...binding,fileId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}}]]) as never;
  assert.throws(()=>bindNfsOptionRelation(relation as never,new Map([[source.entryId,entries.get(source.entryId)]]) as never),/no resolved managed binding/);
  assert.throws(()=>bindNfsOptionRelation({...relation,targetRevisionId:`rev-${"9".repeat(64)}`} as never,entries),/stale exact revision/);
  assert.throws(()=>bindNfsOptionRelation({...relation,edition:"5e"} as never,entries),/crosses edition or language/);
  const mismatched=new Map(entries);mismatched.set(target.entryId,{projection:target,binding:{...binding,sourceId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}});
  assert.throws(()=>bindNfsOptionRelation(relation as never,mismatched as never),/mismatched managed sources/);
});

test("projection and manifest identities are stable and content-derived", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const hash = projectionHash(resolved.manifest.repositoryId, projected);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, projectionHash(resolved.manifest.repositoryId, projected));
  assert.match(entryProjectionHash(projected[0]), /^sha256:[0-9a-f]{64}$/);
  assert.equal(CONTENT_INDEX_PROJECTOR_VERSION, 5);
  const changedSize = structuredClone(projected);
  (changedSize[0].file as { byteSize: number }).byteSize++;
  assert.notEqual(hash, projectionHash(resolved.manifest.repositoryId, changedSize));
  const changedCitation = structuredClone(projected);
  (changedCitation[0].pages[0].citations[0] as { section: string }).section = "Changed section";
  assert.notEqual(hash, projectionHash(resolved.manifest.repositoryId, changedCitation));
  assert.equal(
    deterministicUuid("scope", "a", "b"),
    deterministicUuid("scope", "a", "b"),
  );
  assert.notEqual(deterministicUuid("scope", "a", "b"), deterministicUuid("scope", "a", "c"));
});

test("incremental planning is idempotent and isolates changed and removed managed entries", () => {
  const desired = [
    { entryId: "added", revisionId: `rev-${"a".repeat(64)}`, contentHash: `sha256:${"a".repeat(64)}` },
    { entryId: "changed", revisionId: `rev-${"b".repeat(64)}`, contentHash: `sha256:${"b".repeat(64)}` },
    { entryId: "same", revisionId: `rev-${"c".repeat(64)}`, contentHash: `sha256:${"c".repeat(64)}` },
  ];
  const active = [
    { entry_id: "changed", revision_id: `rev-${"d".repeat(64)}`, content_hash: `sha256:${"d".repeat(64)}` },
    { entry_id: "removed", revision_id: `rev-${"e".repeat(64)}`, content_hash: `sha256:${"e".repeat(64)}` },
    { entry_id: "same", revision_id: `rev-${"c".repeat(64)}`, content_hash: `sha256:${"c".repeat(64)}` },
  ];
  assert.deepEqual(buildSyncPlan("incremental", desired, active), {
    additions: ["added"], updates: ["changed"], removals: ["removed"],
  });
  assert.deepEqual(buildSyncPlan("incremental", desired, desired.map((entry) => ({
    entry_id: entry.entryId, revision_id: entry.revisionId, content_hash: entry.contentHash,
  }))), { additions: [], updates: [], removals: [] });
  assert.deepEqual(buildSyncPlan("clean", desired, active).updates, ["changed", "same"]);
  assert.deepEqual(buildSyncPlan("incremental", [{ ...desired[2], generationId: "new-generation" }], [{
    ...active[2], generation_id: "old-generation",
  }]).updates, ["same"]);
});

test("corrupt canonical hashes are rejected before projection", async () => {
  const path = resolve(dataRoot, "compendium/dash/revisions/rev-42eaa0fa9421910cca58164912c48bd4bf8b39fbba226808f920e35dae090093.json");
  const revision = JSON.parse(await readFile(path, "utf8")) as CanonicalRevision;
  assert.throws(() => assertCanonicalRevision({ ...revision, contentHash: `sha256:${"0".repeat(64)}` }), /content does not match/);
});

test("projector explicitly rejects revisions citing multiple source files", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const revision = structuredClone(resolved.revisions[0]) as CanonicalRevision & {
    citations: Array<Record<string, unknown>>;
  };
  revision.citations.push({ ...revision.citations[0], citationId: "other-citation", fileId: "other-file" });
  assert.throws(
    () => projectCanonicalRevisions(resolved.manifest.repositoryId, [revision], resolved.sourceFiles),
    /cites multiple source files/,
  );
});

test("projector rejects overlapping citations with ambiguous retrieval provenance", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const revision = structuredClone(resolved.revisions[0]) as CanonicalRevision & {
    citations: Array<Record<string, unknown>>;
  };
  revision.citations.push({
    ...revision.citations[0],
    citationId: "ambiguous-citation",
    section: "Different section",
  });
  assert.throws(
    () => projectCanonicalRevisions(resolved.manifest.repositoryId, [revision], resolved.sourceFiles),
    /ambiguous page or section provenance/,
  );
});

test("Dash citation provenance reaches normal search result columns", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const citedChunk = projected[0].chunks.find((chunk) => chunk.pageNumber === 72)!;
  const result = mapSearchChunk({
    id: citedChunk.id,
    source_id: projected[0].sourceUuid,
    file_id: projected[0].fileUuid,
    text: citedChunk.text,
    quote_text: citedChunk.quoteText,
    section_heading: citedChunk.sectionHeading,
    page_number: citedChunk.pageNumber,
    title: projected[0].source.title,
    category: projected[0].source.category,
    edition: projected[0].source.edition,
    language: projected[0].source.language,
    access_tier: projected[0].source.accessTier,
  });
  assert.equal(result.pageNumber, 72);
  assert.equal(result.sectionHeading, "Actions in Combat: Dash");
  assert.equal(result.quoteText, "When you take the Dash action, you gain extra movement for the current turn.");
  const service = await readFile(resolve("src/server/search/service.ts"), "utf8");
  assert.match(service, /c\.section_heading, c\.page_number/);
  assert.match(service, /chunkResult\.rows\.map\(mapSearchChunk\)/);
});

test("projection reconciliation deletes only surplus managed documents, pages, and chunks", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  await reconcileManagedProjectionRows({
    query: async (text, params = []) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0, command: "DELETE", oid: 0, fields: [] };
    },
  }, resolved.manifest.repositoryId, projected);

  assert.equal(calls.length, 4);
  assert.match(calls[0].text, /^SELECT/);
  assert.match(calls[0].text, /unmanaged_collision/);
  assert.match(calls[1].text, /^DELETE FROM chunks/);
  assert.match(calls[2].text, /^DELETE FROM pages/);
  assert.match(calls[3].text, /^DELETE FROM documents/);
  for (const call of calls.slice(1)) {
    assert.match(call.text, /metadata->>'managedBy' = 'nfs-content-index'/);
    assert.match(call.text, /NOT \(id = ANY\(\$2::uuid\[\]\)\)/);
    assert.equal(call.params[0], projected[0].generationId);
  }
  assert.deepEqual(calls[1].params[1], projected[0].chunks.map((chunk) => chunk.id));
  assert.deepEqual(calls[3].params[1], [projected[0].documentId]);
});

test("projection reconciliation refuses deterministic collisions with unmanaged rows", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  let queries = 0;
  await assert.rejects(
    () => reconcileManagedProjectionRows({
      query: async () => {
        queries++;
        return { rows: [{ unmanaged_collision: true }], rowCount: 1, command: "SELECT", oid: 0, fields: [] } as never;
      },
    }, resolved.manifest.repositoryId, projected),
    /conflicts with unmanaged index rows/,
  );
  assert.equal(queries, 1);
});

test("canonical source and file reuse avoids unique inserts and records non-ownership", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const entry = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles)[0];
  const originalSourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const previousGenerationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const incrementalGenerationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.notEqual(originalSourceId, entry.sourceUuid); assert.notEqual(entry.file.fileId, entry.fileUuid);
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  let mappingRepositoryId: string | null = null;
  let retainedPrevious: string | null = null;
  let activeGenerationId = previousGenerationId;
  const binding = await resolveNfsManagedSourceAndFile({ async query(text: string, params: readonly unknown[] = []) {
    calls.push({ text, params });
    if (text.includes("FROM sources s LEFT JOIN")) return result([sourceDatabaseRow(entry, originalSourceId)]);
    if (text.includes("FROM files f LEFT JOIN")) return result([{ id: entry.file.fileId, source_id: originalSourceId, mime_type: entry.file.mediaType, checksum_sha256: entry.file.contentHash.slice(7), byte_size: entry.file.byteSize, active_generation_id: activeGenerationId, deleted_at: null, mapping_repository_id: mappingRepositoryId, owns_file: false, previous_active_generation_id: retainedPrevious, last_nfs_generation_id: null }]);
    if (text.includes("INSERT INTO nfs_index_managed_files")) {
      mappingRepositoryId = String(params[2]);
      retainedPrevious ??= params[5] as string | null;
    }
    return result([]);
  } } as never, resolved.manifest.repositoryId, entry);
  assert.deepEqual(binding, { sourceId: originalSourceId, fileId: entry.file.fileId, ownsSource: false, ownsFile: false });
  assert.equal(calls.some(({ text }) => /^\s*INSERT INTO sources/.test(text)), false);
  assert.equal(calls.some(({ text }) => /^\s*INSERT INTO files/.test(text)), false);
  assert.ok(calls.some(({ text, params }) => text.includes("nfs_index_managed_sources") && params.at(-1) === false));
  const fileMapping = calls.find(({ text }) => text.includes("INSERT INTO nfs_index_managed_files"));
  assert.equal(fileMapping?.params[4], false);
  assert.equal(fileMapping?.params[5], previousGenerationId);
  assert.match(fileMapping!.text, /previous_active_generation_id=nfs_index_managed_files\.previous_active_generation_id/);
  assert.match(fileMapping!.text, /last_nfs_generation_id=nfs_index_managed_files\.last_nfs_generation_id/);
  activeGenerationId = incrementalGenerationId;
  await resolveNfsManagedSourceAndFile({ async query(text: string, params: readonly unknown[] = []) {
    if (text.includes("FROM sources s LEFT JOIN")) return result([sourceDatabaseRow(entry, originalSourceId)]);
    if (text.includes("FROM files f LEFT JOIN")) return result([{ id: entry.file.fileId, source_id: originalSourceId, mime_type: entry.file.mediaType, checksum_sha256: entry.file.contentHash.slice(7), byte_size: entry.file.byteSize, active_generation_id: activeGenerationId, deleted_at: null, mapping_repository_id: mappingRepositoryId, owns_file: false, previous_active_generation_id: retainedPrevious, last_nfs_generation_id: null }]);
    if (text.includes("INSERT INTO nfs_index_managed_files")) retainedPrevious ??= params[5] as string | null;
    return result([]);
  } } as never, resolved.manifest.repositoryId, entry);
  assert.equal(retainedPrevious, previousGenerationId);
});

test("absent canonical identities create owned mappings", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const entry = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles)[0];
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const binding = await resolveNfsManagedSourceAndFile({ async query(text: string, params: readonly unknown[] = []) { calls.push({ text, params }); return result([]); } } as never, resolved.manifest.repositoryId, entry);
  assert.deepEqual(binding, { sourceId: entry.sourceUuid, fileId: entry.fileUuid, ownsSource: true, ownsFile: true });
  assert.ok(calls.some(({ text }) => /^\s*INSERT INTO sources/.test(text)));
  assert.ok(calls.some(({ text }) => /^\s*INSERT INTO files/.test(text)));
  assert.ok(calls.some(({ text, params }) => text.includes("nfs_index_managed_sources") && params.at(-1) === true));
  assert.ok(calls.some(({ text, params }) => text.includes("INSERT INTO nfs_index_managed_files") && params[4] === true && params[5] === null));
});

test("conflicting canonical source access and publication metadata fails before mapping", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const entry = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles)[0];
  let mappings = 0;
  await assert.rejects(resolveNfsManagedSourceAndFile({ async query(text: string) {
    if (text.includes("FROM sources s LEFT JOIN")) return result([{ ...sourceDatabaseRow(entry, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), access_tier: entry.source.accessTier === "open" ? "premium" : "open" }]);
    if (text.includes("nfs_index_managed_")) mappings++;
    return result([]);
  } } as never, resolved.manifest.repositoryId, entry), /conflicts on access_tier/);
  assert.equal(mappings, 0);
});

test("reused-file activation fences first and incremental NFS generations", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles)[0];
  const previousId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const nextId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const state: ActivationFixture = { active: previousId, previous: previousId, last: null, ownsFile: false, generations: new Map([[previousId, "active"]]), archives: 0, casFails: false };
  const binding = { sourceId: projected.sourceUuid, fileId: projected.fileUuid, ownsSource: false, ownsFile: false };
  await activateManagedGeneration(activationClient(state) as never, resolved.manifest.repositoryId, { ...projected, generationId: firstId }, binding);
  assert.equal(state.active, firstId);
  assert.equal(state.last, firstId);
  assert.equal(state.generations.get(previousId), "archived");
  await activateManagedGeneration(activationClient(state) as never, resolved.manifest.repositoryId, { ...projected, generationId: nextId }, binding);
  assert.equal(state.active, nextId);
  assert.equal(state.last, nextId);
  assert.equal(state.generations.get(firstId), "archived");
  assert.equal(state.generations.get(nextId), "active");
});

test("external activation between NFS generations rejects before archive or pointer mutation", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles)[0];
  const previousId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", firstId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const externalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", nextId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const state: ActivationFixture = { active: previousId, previous: previousId, last: null, ownsFile: false, generations: new Map([[previousId, "active"]]), archives: 0, casFails: false };
  const binding = { sourceId: projected.sourceUuid, fileId: projected.fileUuid, ownsSource: false, ownsFile: false };
  await activateManagedGeneration(activationClient(state) as never, resolved.manifest.repositoryId, { ...projected, generationId: firstId }, binding);
  state.generations.set(firstId, "archived");
  state.generations.set(externalId, "active");
  state.active = externalId;
  const archivesBefore = state.archives;
  await assert.rejects(activateManagedGeneration(activationClient(state) as never, resolved.manifest.repositoryId, { ...projected, generationId: nextId }, binding), /changed outside NFS synchronization/);
  assert.equal(state.active, externalId);
  assert.equal(state.last, firstId);
  assert.equal(state.generations.has(nextId), false);
  assert.equal(state.archives, archivesBefore);
});

test("reused-file activation rolls back when the generation mapping CAS loses", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles)[0];
  const previousId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", candidateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const state: ActivationFixture = { active: previousId, previous: previousId, last: null, ownsFile: false, generations: new Map([[previousId, "active"]]), archives: 0, casFails: true };
  const binding = { sourceId: projected.sourceUuid, fileId: projected.fileUuid, ownsSource: false, ownsFile: false };
  await assert.rejects(mockActivationTransaction(state, (client) => activateManagedGeneration(client as never, resolved.manifest.repositoryId, { ...projected, generationId: candidateId }, binding)), /claim changed concurrently/);
  assert.equal(state.active, previousId);
  assert.equal(state.last, null);
  assert.deepEqual([...state.generations], [[previousId, "active"]]);
  assert.equal(state.archives, 0);
});

test("reused-file cleanup restores the retained generation and removes stale NFS retrieval rows idempotently", async () => {
  const repositoryId = "repo", fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const previousId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", nfsId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", staleNfsId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const state = { active: nfsId as string | null, previous: previousId as string | null, last: nfsId as string | null, nfsIds: [staleNfsId,nfsId], entries: true, file: true, generations: new Map([[previousId,"archived"],[staleNfsId,"archived"],[nfsId,"active"]]), documents: true, pages: true, chunks: true };
  const client = cleanupClient(state, { repositoryId, fileId, sourceId, ownsFile: false });
  await cleanupRemovedNfsFile(client as never, repositoryId, fileId);
  assert.equal(state.active, previousId); assert.equal(state.generations.get(previousId), "active"); assert.equal(state.generations.has(nfsId), false); assert.equal(state.generations.has(staleNfsId), false);
  assert.equal(state.entries, false); assert.equal(state.documents, false); assert.equal(state.pages, false); assert.equal(state.chunks, false); assert.equal(state.file, true);
  await cleanupRemovedNfsFile(client as never, repositoryId, fileId);
  assert.equal(state.active, previousId); assert.equal(state.file, true);
});

test("reused-file cleanup fails closed when active generation changed externally", async () => {
  const repositoryId = "repo", fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const state = { active: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as string | null, previous: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as string | null, last: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as string | null, nfsIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"], entries: true, file: true, generations: new Map<string,string>(), documents: true, pages: true, chunks: true };
  await assert.rejects(cleanupRemovedNfsFile(cleanupClient(state, { repositoryId, fileId, sourceId, ownsFile: false }) as never, repositoryId, fileId), /changed outside NFS synchronization/);
  assert.equal(state.entries, true); assert.equal(state.file, true);
});

test("reused-file cleanup restores NULL when the retained generation is invalid", async () => {
  const repositoryId = "repo", fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const nfsId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const state = { active: nfsId as string | null, previous: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as string | null, last: nfsId as string | null, nfsIds: [nfsId], entries: true, file: true, generations: new Map([[nfsId,"active"]]), documents: true, pages: true, chunks: true };
  await cleanupRemovedNfsFile(cleanupClient(state, { repositoryId, fileId, sourceId, ownsFile: false }) as never, repositoryId, fileId);
  assert.equal(state.active, null);
  assert.equal(state.previous, null);
  assert.equal(state.generations.has(nfsId), false);
  assert.equal(state.entries, false);
  assert.equal(state.file, true);
});

test("owned-file cleanup deletes the file and cascades NFS artifacts", async () => {
  const repositoryId = "repo", fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", nfsId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const state = { active: nfsId as string | null, previous: null, last: nfsId as string | null, nfsIds: [nfsId], entries: true, file: true, generations: new Map([[nfsId,"active"]]), documents: true, pages: true, chunks: true };
  await cleanupRemovedNfsFile(cleanupClient(state, { repositoryId, fileId, sourceId, ownsFile: true }) as never, repositoryId, fileId);
  assert.equal(state.file, false); assert.equal(state.entries, false); assert.equal(state.generations.size, 0); assert.equal(state.documents, false); assert.equal(state.pages, false); assert.equal(state.chunks, false);
});

type CleanupState = { active:string|null;previous:string|null;last:string|null;nfsIds:string[];entries:boolean;file:boolean;generations:Map<string,string>;documents:boolean;pages:boolean;chunks:boolean };
function cleanupClient(state:CleanupState, ids:{repositoryId:string;fileId:string;sourceId:string;ownsFile:boolean}) { return { async query(text:string,params:readonly unknown[]=[]){
  if(text.includes("SELECT file.source_id")) return result(state.file ? [{source_id:ids.sourceId,active_generation_id:state.active,owns_file:ids.ownsFile,previous_active_generation_id:state.previous,last_nfs_generation_id:state.last,nfs_generation_ids:state.entries?state.nfsIds:[]}] : []);
  if(text.startsWith("SELECT id FROM ingestion_generations")) return result(state.previous&&state.generations.has(state.previous)?[{id:state.previous}]:[]);
  if(text.startsWith("UPDATE ingestion_generations SET status='archived'")){for(const id of params[0] as string[])state.generations.set(id,"archived");return changed(1);}
  if(text.startsWith("UPDATE ingestion_generations SET status='active'")){state.generations.set(String(params[0]),"active");return changed(1);}
  if(text.startsWith("UPDATE files SET active_generation_id")){if(state.active!==params[1])return changed(0);state.active=params[2] as string|null;return changed(1);}
  if(text.startsWith("DELETE FROM nfs_index_entries")){state.entries=false;return changed(1);}
  if(text.startsWith("DELETE FROM ingestion_generations")){for(const id of params[0] as string[]){state.generations.delete(id);if(state.last===id)state.last=null;}state.documents=false;state.pages=false;state.chunks=false;state.nfsIds=[];return changed(1);}
  if(text.startsWith("DELETE FROM files")){state.file=false;state.entries=false;state.generations.clear();state.documents=false;state.pages=false;state.chunks=false;return changed(1);}
  if(text.startsWith("UPDATE nfs_index_managed_files SET previous")){state.previous=null;return changed(1);} throw new Error(`Unexpected cleanup SQL: ${text}`);
} }; }
function changed(rowCount:number){return {rows:rowCount?[{id:"changed"}]:[],rowCount,command:"UPDATE",oid:0,fields:[]} as never;}

type ActivationFixture = { active: string | null; previous: string | null; last: string | null; ownsFile: boolean; generations: Map<string, string>; archives: number; casFails: boolean };
function activationClient(state: ActivationFixture) { return { async query(text: string, params: readonly unknown[] = []) {
  if (text.includes("SELECT file.active_generation_id")) return result([{ active_generation_id: state.active, owns_file: state.ownsFile, previous_active_generation_id: state.previous, last_nfs_generation_id: state.last }]);
  if (text.startsWith("INSERT INTO ingestion_generations") && text.includes("'staged'")) { if (!state.generations.has(String(params[0]))) state.generations.set(String(params[0]), "staged"); return changed(1); }
  if (text.startsWith("UPDATE nfs_index_managed_files SET last_nfs_generation_id")) {
    if (state.casFails || state.last !== params[3]) return changed(0);
    state.last = String(params[2]); return changed(1);
  }
  if (text.startsWith("UPDATE ingestion_generations SET status='archived'")) { for (const [id, status] of state.generations) if (status === "active" && id !== params[1]) { state.generations.set(id, "archived"); state.archives++; } return changed(1); }
  if (text.startsWith("UPDATE ingestion_generations SET status='active'")) { state.generations.set(String(params[0]), "active"); return changed(1); }
  if (text.startsWith("UPDATE files SET active_generation_id")) { if (state.active !== params[1]) return changed(0); state.active = String(params[2]); return changed(1); }
  throw new Error(`Unexpected activation SQL: ${text}`);
} }; }
async function mockActivationTransaction(state: ActivationFixture, operation: (client: ReturnType<typeof activationClient>) => Promise<void>) {
  const snapshot = { active: state.active, previous: state.previous, last: state.last, generations: new Map(state.generations), archives: state.archives };
  try { await operation(activationClient(state)); } catch (error) {
    state.active = snapshot.active; state.previous = snapshot.previous; state.last = snapshot.last;
    state.generations = snapshot.generations; state.archives = snapshot.archives;
    throw error;
  }
}

function sourceDatabaseRow(entry: ReturnType<typeof projectCanonicalRevisions>[number], id: string) {
  return { id, title: entry.source.title, category: entry.source.category, edition: entry.source.edition, language: entry.source.language, access_tier: entry.source.accessTier, shared: entry.source.shared, owner_user_id: entry.source.ownerUserId, publication_code: entry.source.publication.code, publication_title: entry.source.publication.title, publisher: entry.source.publication.publisher, release_year: entry.source.publication.releaseYear, publication_revision: entry.source.publication.revision ?? null, external_origin_url: entry.source.publication.origin?.url ?? null, external_origin_id: entry.source.publication.origin?.id ?? null, attribution: entry.source.publication.attribution ?? null, source_priority: entry.source.publication.sourcePriority, canonical_book_id: entry.source.publication.canonicalBookId, license: entry.source.license ?? null, deleted_at: null, mapping_repository_id: null, owns_source: null };
}
function fakeBoundProjection(entryId:string,fileUuid:string,sourceUuid:string,revision:string,relations:unknown[]){const revisionId=`rev-${revision.repeat(64)}`;return{id:`id-${entryId}`,entryId,revisionId,contentHash:`sha256:${revision.repeat(64)}`,entryType:entryId.startsWith("species-")?"other":"classFeature",name:entryId,aliases:[],typedFields:[],plainText:`${entryId} rules`,canonicalPayload:{},source:{sourceId:"canonical-source",title:"Source",category:"core_rules",edition:"5.5e",language:"en",accessTier:"open",shared:false,ownerUserId:null,publication:{code:"SRC",title:"Source",publisher:"Fixture",releaseYear:2024,revision:"2024",sourcePriority:1,canonicalBookId:"source"},files:[]},file:{fileId:fileUuid,path:`files/${fileUuid}`,mediaType:"text/plain",contentHash:`sha256:${"f".repeat(64)}`,byteSize:10},sourceUuid,fileUuid,generationId:`gen-${fileUuid}`,documentId:`doc-${entryId}`,pages:[],chunks:[],relations} as never;}
function fakeRelation(sourceEntryId:string,sourceRevision:string,targetEntryId:string,targetRevision:string,sourceId:string,relationKind:"parent"|"cross_link"){return{sourceEntryId,sourceRevisionId:`rev-${sourceRevision.repeat(64)}`,sourceId,targetEntryId,targetRevisionId:`rev-${targetRevision.repeat(64)}`,targetSourceId:sourceId,edition:"5.5e",language:"en",relationKind,targetKind:targetEntryId.startsWith("species-")?"species":"class",targetLifecycle:"active",sourceAnchor:"",anchor:null,position:0};}
function classReaderFields(){return[{key:"kind",value:"subclass"},{key:"hit-die",value:10},{key:"primary-ability",value:"Strength"},{key:"parent-class-ids",value:["class-17"]},{key:"progression-columns",value:[]},{key:"progression-rows",value:[]},{key:"features",value:[]},{key:"cross-links",value:[]}];}
function result(rows: readonly Record<string, unknown>[]) { return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never; }

test("validate mode completes without any database access", async () => {
  let queried = false;
  const result = await synchronizeContentIndex(
    { mode: "validate", dataRoot },
    { execute: async () => {
      queried = true;
      throw new Error("database must not be queried");
    } },
  );
  assert.equal(queried, false);
  assert.equal(result.mode, "validate");
  assert.equal(result.runId, null);
});

test("an immediately repeated incremental snapshot performs zero mutations", async () => {
  const resolved = await loadResolvedCanonicalRevisions(dataRoot);
  const projected = projectCanonicalRevisions(resolved.manifest.repositoryId, resolved.revisions, resolved.sourceFiles);
  const sql: string[] = [];
  const result = await synchronizeContentIndex(
    { mode: "incremental", dataRoot },
    { execute: async (text) => {
      sql.push(text);
      return {
        rows: projected.map((entry) => ({
          entry_id: entry.entryId,
          revision_id: entry.revisionId,
          content_hash: entry.contentHash,
          file_id: entry.fileUuid,
          generation_id: entry.generationId,
        })),
        rowCount: projected.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      };
    } },
  );
  assert.deepEqual(result.plan, { additions: [], updates: [], removals: [] });
  assert.equal(result.runId, null);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT entry_id/);
});

test("dry-run with planned changes is database-pure", async () => {
  const sql: string[] = [];
  const result = await synchronizeContentIndex(
    { mode: "clean", dryRun: true, dataRoot },
    {
      execute: async (text) => {
        sql.push(text);
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
      transaction: async () => { throw new Error("dry-run must not start a transaction"); },
    },
  );
  assert.deepEqual(result.plan.additions, ["dash"]);
  assert.equal(result.runId, null);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT entry_id/);
});

test("run leases resume matching owners, reject live owners, and supersede only stale runs", async () => {
  type Run = {
    id: string;
    repository: string;
    projectionHash: string;
    mode: "incremental" | "clean";
    owner: string;
    expiresAt: number;
    status: "staging" | "failed" | "succeeded";
  };
  const runs: Run[] = [];
  let now = 1_000;
  const execute = async (text: string, params: readonly unknown[] = []) => {
    assert.match(text, /^SELECT run_id, resumed FROM claim_nfs_index_sync_run/);
    const repository = String(params[1]);
    const mode = params[2] as Run["mode"];
    const projectionHashValue = String(params[3]);
    const owner = String(params[9]);
    const leaseSeconds = Number(params[10]);
    const active = runs.find((run) => run.repository === repository && run.status === "staging");
    if (active) {
      if (active.owner === owner && active.projectionHash === projectionHashValue
        && active.mode === mode && active.expiresAt > now) {
        active.expiresAt = now + leaseSeconds;
        return { rows: [{ run_id: active.id, resumed: true }] } as never;
      }
      if (active.expiresAt > now) throw new Error("another live NFS index sync owner holds repository");
      if (active.projectionHash === projectionHashValue && active.mode === mode) {
        active.owner = owner;
        active.expiresAt = now + leaseSeconds;
        return { rows: [{ run_id: active.id, resumed: true }] } as never;
      }
      active.status = "failed";
    }
    const created: Run = {
      id: String(params[0]), repository, mode, projectionHash: projectionHashValue,
      owner, expiresAt: now + leaseSeconds, status: "staging",
    };
    runs.push(created);
    return { rows: [{ run_id: created.id, resumed: false }] } as never;
  };
  const input = {
    repositoryId: "repository",
    manifestHash: `sha256:${"a".repeat(64)}`,
    generation: null,
    mode: "incremental" as const,
    plan: { additions: ["dash"], updates: [], removals: [] },
    ownerToken: "11111111-1111-4111-8111-111111111111",
    leaseSeconds: 60,
  };
  const first = await claimContentIndexRun(execute, input);
  const second = await claimContentIndexRun(execute, input);
  assert.equal(first.id, second.id);
  assert.deepEqual([first.resumed, second.resumed], [false, true]);
  await assert.rejects(
    () => claimContentIndexRun(execute, {
      ...input,
      manifestHash: `sha256:${"b".repeat(64)}`,
      ownerToken: "22222222-2222-4222-8222-222222222222",
    }),
    /live NFS index sync owner/,
  );
  now += 61;
  const recovered = await claimContentIndexRun(execute, {
    ...input,
    ownerToken: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.resumed, true);
  now += 61;
  const takeover = await claimContentIndexRun(execute, {
    ...input,
    manifestHash: `sha256:${"b".repeat(64)}`,
    ownerToken: "33333333-3333-4333-8333-333333333333",
  });
  assert.notEqual(takeover.id, first.id);
  assert.equal(runs.find((run) => run.id === first.id)?.status, "failed");
  const succeeded = runs.find((run) => run.id === takeover.id)!;
  succeeded.status = "succeeded";
  const afterSuccess = await claimContentIndexRun(execute, {
    ...input,
    manifestHash: `sha256:${"c".repeat(64)}`,
    ownerToken: "44444444-4444-4444-8444-444444444444",
  });
  assert.notEqual(afterSuccess.id, takeover.id);
  assert.equal(succeeded.status, "succeeded");
});

test("heartbeat cannot revive an expired or differently owned run", async () => {
  let params: readonly unknown[] = [];
  await assert.rejects(
    () => heartbeatContentIndexRun(async (text, values = []) => {
      assert.match(text, /owner_token = \$2/);
      assert.match(text, /lease_expires_at > clock_timestamp\(\)/);
      params = values;
      return { rows: [] } as never;
    }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 30),
    /not owned or has expired/,
  );
  assert.deepEqual(params, [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    30,
  ]);
});

test("an interrupted staging run resumes from persisted entry checkpoints", async () => {
  let runId: string | null = null;
  const staged = new Map<string, { payload_hash: string; projector_version: number }>();
  let stagingInserts = 0;
  let activationReached = false;
  const execute = async (text: string, params: readonly unknown[] = []) => {
    if (text.startsWith("SELECT entry_id, revision_id")) return { rows: [] } as never;
    if (text.startsWith("SELECT run_id, resumed FROM claim_nfs_index_sync_run")) {
      const resumed = runId !== null;
      runId ??= String(params[0]);
      return { rows: [{ run_id: runId, resumed }] } as never;
    }
    if (text.startsWith("UPDATE nfs_index_sync_runs\n     SET heartbeat_at")) return { rows: [{ id: runId }] } as never;
    if (text.startsWith("SELECT entry_id, payload_hash")) {
      return { rows: [...staged].map(([entry_id, checkpoint]) => ({ entry_id, ...checkpoint })) } as never;
    }
    if (text.startsWith("INSERT INTO nfs_index_sync_staging")) {
      staged.set(String(params[1]), {
        projector_version: Number(params[4]),
        payload_hash: String(params[5]),
      });
      stagingInserts++;
      return { rows: [], rowCount: 1 } as never;
    }
    if (text.startsWith("SELECT count(*)")) return { rows: [{ count: String(staged.size) }] } as never;
    return { rows: [], rowCount: 1 } as never;
  };

  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        ownerToken: "11111111-1111-4111-8111-111111111111",
        afterCheckpoint: () => { throw new Error("simulated interruption"); },
      },
    ),
    /simulated interruption/,
  );
  assert.equal(staged.size, 1);

  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        ownerToken: "11111111-1111-4111-8111-111111111111",
        afterCheckpoint: () => { throw new Error("completed checkpoint must be skipped"); },
        transaction: async () => {
          activationReached = true;
          throw new Error("stop before test activation");
        },
      },
    ),
    /stop before test activation/,
  );
  assert.equal(stagingInserts, 1);
  assert.equal(activationReached, true);
});

test("resume rejects a corrupted persisted projection checkpoint", async () => {
  let runId: string | null = null;
  const staged = new Map<string, { payload_hash: string; projector_version: number }>();
  const execute = async (text: string, params: readonly unknown[] = []) => {
    if (text.startsWith("SELECT entry_id, revision_id")) return { rows: [] } as never;
    if (text.startsWith("SELECT run_id, resumed FROM claim_nfs_index_sync_run")) {
      const resumed = runId !== null;
      runId ??= String(params[0]);
      return { rows: [{ run_id: runId, resumed }] } as never;
    }
    if (text.startsWith("UPDATE nfs_index_sync_runs\n     SET heartbeat_at")) return { rows: [{ id: runId }] } as never;
    if (text.startsWith("SELECT entry_id, payload_hash")) {
      return { rows: [...staged].map(([entry_id, checkpoint]) => ({ entry_id, ...checkpoint })) } as never;
    }
    if (text.startsWith("INSERT INTO nfs_index_sync_staging")) {
      staged.set(String(params[1]), { projector_version: Number(params[4]), payload_hash: String(params[5]) });
      return { rows: [], rowCount: 1 } as never;
    }
    if (text.startsWith("SELECT count(*)")) return { rows: [{ count: String(staged.size) }] } as never;
    return { rows: [], rowCount: 1 } as never;
  };
  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      {
        execute,
        ownerToken: "11111111-1111-4111-8111-111111111111",
        afterCheckpoint: () => { throw new Error("interrupt"); },
      },
    ),
    /interrupt/,
  );
  const entryId = [...staged.keys()][0];
  staged.set(entryId, { projector_version: CONTENT_INDEX_PROJECTOR_VERSION, payload_hash: `sha256:${"0".repeat(64)}` });
  await assert.rejects(
    () => synchronizeContentIndex(
      { mode: "incremental", dataRoot },
      { execute, ownerToken: "11111111-1111-4111-8111-111111111111" },
    ),
    /does not match the freshly validated projection/,
  );
});
