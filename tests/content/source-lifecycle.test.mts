import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_ARCHIVE_ERROR_CODES,
  SourceArchiveError,
  archiveSourceWithClient,
} from "../../src/server/content/source-lifecycle.ts";

type QueryResult = Readonly<{ rows: readonly Record<string, unknown>[] }>;
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

class SequencedClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  private readonly results: readonly QueryResult[];

  constructor(results: readonly QueryResult[]) {
    this.results = results;
  }

  async query(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    const result = this.results[this.calls.length - 1];
    assert.ok(result, `Unexpected query: ${sql}`);
    return result;
  }
}

test("source archival locks and soft-deletes only the source after all guards pass", async () => {
  const archivedAt = new Date("2026-08-10T12:00:00.000Z");
  const client = new SequencedClient([
    { rows: [{ id: "source-1", title: "Rules", deleted_at: null }] },
    { rows: [] },
    { rows: [] },
    { rows: [{ id: "source-1", title: "Rules", deleted_at: archivedAt }] },
  ]);

  assert.deepEqual(await archiveSourceWithClient(client as never, SOURCE_ID, "Rules"), {
    id: "source-1",
    title: "Rules",
    deletedAt: archivedAt.toISOString(),
  });
  assert.match(client.calls[0]?.sql ?? "", /FROM sources WHERE id = \$1 FOR UPDATE/);
  assert.match(client.calls[1]?.sql ?? "", /ingestion_jobs/);
  assert.match(client.calls[2]?.sql ?? "", /nfs_index_managed_sources/);
  assert.match(client.calls[3]?.sql ?? "", /^UPDATE sources/);
  assert.doesNotMatch(client.calls.map(({ sql }) => sql).join("\n"), /DELETE FROM|files|storage_path/);
});

test("source archival rejects a stale confirmation before checking jobs", async () => {
  const client = new SequencedClient([
    { rows: [{ id: "source-1", title: "Current title", deleted_at: null }] },
  ]);

  await rejectsWithCode(
    archiveSourceWithClient(client as never, SOURCE_ID, "Old title"),
    SOURCE_ARCHIVE_ERROR_CODES.titleMismatch,
  );
  assert.equal(client.calls.length, 1);
});

test("source archival rejects active jobs without mutating the source", async () => {
  const client = new SequencedClient([
    { rows: [{ id: "source-1", title: "Rules", deleted_at: null }] },
    { rows: [{ id: "job-1", status: "processing" }] },
  ]);

  await rejectsWithCode(
    archiveSourceWithClient(client as never, SOURCE_ID, "Rules"),
    SOURCE_ARCHIVE_ERROR_CODES.activeJobs,
  );
  assert.equal(client.calls.length, 2);
});

test("source archival rejects NFS-managed sources without mutating preserved content", async () => {
  const client = new SequencedClient([
    { rows: [{ id: "source-1", title: "Rules", deleted_at: null }] },
    { rows: [] },
    { rows: [{ repository_id: "repository-1" }] },
  ]);

  await rejectsWithCode(
    archiveSourceWithClient(client as never, SOURCE_ID, "Rules"),
    SOURCE_ARCHIVE_ERROR_CODES.nfsManaged,
  );
  assert.equal(client.calls.length, 3);
  assert.doesNotMatch(client.calls.map(({ sql }) => sql).join("\n"), /^UPDATE sources/m);
});

test("source archival distinguishes missing and already archived sources", async () => {
  await rejectsWithCode(
    archiveSourceWithClient(new SequencedClient([{ rows: [] }]) as never, SOURCE_ID, "Rules"),
    SOURCE_ARCHIVE_ERROR_CODES.notFound,
  );
  await rejectsWithCode(
    archiveSourceWithClient(new SequencedClient([{
      rows: [{ id: "source-1", title: "Rules", deleted_at: new Date() }],
    }]) as never, SOURCE_ID, "Rules"),
    SOURCE_ARCHIVE_ERROR_CODES.alreadyArchived,
  );
});

test("source archival rejects malformed source IDs before querying PostgreSQL", async () => {
  await rejectsWithCode(
    archiveSourceWithClient({ query: async () => assert.fail("database must not be queried") } as never, "not-a-uuid", "Rules"),
    SOURCE_ARCHIVE_ERROR_CODES.notFound,
  );
});

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SourceArchiveError);
    assert.equal(error.code, code);
    assert.equal(error.status, code === SOURCE_ARCHIVE_ERROR_CODES.notFound ? 404 : 409);
    return true;
  });
}
