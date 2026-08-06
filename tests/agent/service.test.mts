import assert from "node:assert/strict";
import test from "node:test";

import { CursorCodec } from "../../src/server/agent/cursor.ts";
import { AgentReadService } from "../../src/server/agent/service.ts";

const cursors = new CursorCodec("test-cursor-secret-that-is-at-least-32-bytes");

const row = {
  id: "10000000-0000-4000-8000-000000000001",
  entry_id: "dash",
  revision_id: `rev-${"a".repeat(64)}`,
  content_hash: `sha256:${"a".repeat(64)}`,
  entry_type: "action",
  name: "Dash",
  aliases: ["Dash action"],
  typed_fields: [{ key: "cost", value: "Action" }],
  plain_text: "Dash text.",
  canonical_payload: {
    text: { plain: "Dash text.", sections: [{ sectionId: "dash-rule", heading: "Dash", text: "Dash text.", startOffset: 0, endOffset: 10 }] },
    citations: [{ citationId: "dash-citation", sourceId: "source", fileId: "file", page: 72, section: "Dash", quote: "Dash text.", startOffset: 0, endOffset: 10 }],
    source: { sourceId: "srd", title: "Basic Rules" },
  },
  source_id: "20000000-0000-4000-8000-000000000001",
  file_id: "30000000-0000-4000-8000-000000000001",
  edition: "5e",
  language: "en",
};

test("all indexed reads reuse the centralized #81 SQL source predicate for each role", async () => {
  const cases = [
    { user: { role: "user" } as const, tiers: ["open"], values: [] },
    { user: { role: "premium", userId: "owner" } as const, tiers: ["open", "premium", "personal"], values: ["owner"] },
    { user: { role: "premium", userId: "nonowner" } as const, tiers: ["open", "premium", "personal"], values: ["nonowner"] },
    { user: { role: "admin" } as const, tiers: [], values: [] },
  ];
  for (const roleCase of cases) {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const service = new AgentReadService({
      async query(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        return { rows: [] } as never;
      },
    }, cursors);
    assert.deepEqual(await service.listEntries(roleCase.user), { items: [], nextCursor: null });
    await service.listEntityTypes(roleCase.user);
    await service.listChangedEntries(roleCase.user, { since: "2026-01-01T00:00:00Z" });
    for (const call of calls) {
      assert.match(call.sql, /JOIN sources s/);
      for (const tier of roleCase.tiers) assert.match(call.sql, new RegExp(`s\\.access_tier = '${tier}'`));
      if (roleCase.user.role === "admin") assert.doesNotMatch(call.sql, /s\.access_tier/);
      for (const value of roleCase.values) assert.ok(call.values.includes(value));
    }
  }
});

test("entry, citation, and section reads return stable IDs and source provenance", async () => {
  const service = new AgentReadService({ async query() { return { rows: [row] } as never; } }, cursors);
  const entry = await service.getEntry({ role: "user" }, "dash");
  assert.equal(entry.id, row.id);
  assert.equal(entry.entryId, "dash");
  assert.equal(entry.revisionId, row.revision_id);
  assert.equal(entry.sourceId, row.source_id);
  assert.equal(entry.citations[0] && (entry.citations[0] as { citationId: string }).citationId, "dash-citation");

  const citations = await service.getCitations({ role: "user" }, "dash");
  assert.deepEqual(citations, {
    entryId: "dash",
    revisionId: row.revision_id,
    sourceId: row.source_id,
    fileId: row.file_id,
    citations: row.canonical_payload.citations,
  });
  const section = await service.readSection({ role: "user" }, "dash", "dash-rule");
  assert.equal((section.section as { sectionId: string }).sectionId, "dash-rule");
  assert.deepEqual(section.citations, row.canonical_payload.citations);
});

test("list pagination uses an opaque stable keyset cursor", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let queryNumber = 0;
  const service = new AgentReadService({
    async query(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      queryNumber++;
      return { rows: queryNumber === 1 ? [row, { ...row, id: "10000000-0000-4000-8000-000000000002", entry_id: "dodge" }] : [] } as never;
    },
  }, cursors);
  const first = await service.listEntries({ role: "user" }, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await service.listEntries({ role: "user" }, { limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(second, { items: [], nextCursor: null });
  await assert.rejects(
    () => service.listEntries({ role: "user" }, { edition: "5.5e", limit: 1, cursor: first.nextCursor! }),
    /cursor is invalid/,
  );
  assert.match(calls[0].sql, /ORDER BY entry_id, id/);
  assert.match(calls[1].sql, /\(entry_id, id\) >/);
  assert.ok(calls[1].values.includes("dash"));
  assert.ok(calls[1].values.includes(row.id));
});

test("search pagination preserves rank and stable ID while returning citation provenance", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let queryNumber = 0;
  const ranked = { ...row, rank: 0.75, snippet: "<b>Dash</b> text." };
  const service = new AgentReadService({
    async query(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      queryNumber++;
      return { rows: queryNumber === 1 ? [ranked, { ...ranked, id: "10000000-0000-4000-8000-000000000002" }] : [] } as never;
    },
  }, cursors);
  const first = await service.searchEntries({ role: "user" }, { query: "dash", limit: 1 });
  assert.deepEqual(first.items[0].citations, row.canonical_payload.citations);
  assert.deepEqual(first.items[0].source, row.canonical_payload.source);
  assert.ok(first.nextCursor);
  await service.searchEntries({ role: "user" }, { query: "dash", limit: 1, cursor: first.nextCursor! });
  assert.match(calls[0].sql, /ORDER BY rank DESC, entry_id, id/);
  assert.match(calls[1].sql, /\(entry_id, id\) >/);
  assert.ok(calls[1].values.includes(0.75));
  assert.ok(calls[1].values.includes(row.id));
});

test("changed-entry reads expose upsert and deletion cursors without filesystem access", async () => {
  const service = new AgentReadService({
    async query(sql: string) {
      assert.doesNotMatch(sql, /storage_path|canonical_payload/);
      assert.match(sql, /s\.deleted_at IS NULL/);
      assert.match(sql, /f\.deleted_at IS NULL/);
      return { rows: [
        { id: row.id, entry_id: "dash", revision_id: row.revision_id, lifecycle: "active", indexed_at: "2026-01-02T00:00:00Z", retired_at: null },
        { id: "other", entry_id: "dodge", revision_id: row.revision_id, lifecycle: "retired", indexed_at: "2026-01-01T00:00:00Z", retired_at: "2026-01-03T00:00:00Z" },
      ] } as never;
    },
  }, cursors);
  const result = await service.listChangedEntries({ role: "admin" }, { since: "2026-01-01T00:00:00Z", limit: 1 });
  assert.equal(result.items[0].change, "upserted");
  assert.equal(result.items[0].changedAt, "2026-01-02T00:00:00.000Z");
  assert.ok(result.nextCursor);
});
