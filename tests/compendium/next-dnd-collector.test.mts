import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectNextDndSnapshots } from "../../src/server/compendium/next-dnd/collector.ts";
import { spellDetailFixture, spellIndexFixture } from "../fixtures/next-dnd/spells.mts";

test("collects immutable raw HTML, retries, reports failures, and replays from cache idempotently", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "next-dnd-snapshot-"));
  const attempts = new Map<string, number>();
  const sleeps: number[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    const count = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, count);
    if (url.endsWith("/spells/")) return new Response(spellIndexFixture(2), { status: 200 });
    const externalId = url.match(/\/spells\/(\d+)/)?.[1] ?? "missing";
    if (externalId === "10195" && count === 1) return new Response("busy", { status: 503, statusText: "Busy" });
    return new Response(spellDetailFixture(externalId, externalId === "10195"), { status: 200 });
  };
  const now = () => new Date("2026-08-06T12:00:00.000Z");

  const first = await collectNextDndSnapshots({
    outputDirectory,
    categories: ["spells"],
    minimumDelayMs: 10,
    retries: 1,
    fetch: fetcher,
    now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(first.manifest.categories[0].entryCount, 2);
  assert.equal(first.manifest.categories[0].details.length, 1);
  assert.equal(first.manifest.parserFailures.length, 1);
  assert.equal(first.manifest.parserFailures[0].phase, "parse");
  assert.equal(first.manifest.parserFailures[0].externalId, "20001");
  assert.ok(first.manifest.parserFailures[0].snapshot);
  assert.ok(sleeps.some((milliseconds) => milliseconds === 500), "expected exponential retry backoff");
  assert.equal(attempts.get("https://next.dnd.su/spells/10195-hunters-mark"), 2);

  const rawIndex = await readFile(join(outputDirectory, first.manifest.categories[0].index!.blobPath), "utf8");
  const failedRaw = await readFile(join(outputDirectory, first.manifest.parserFailures[0].snapshot!.blobPath), "utf8");
  assert.match(rawIndex, /window\.LIST/);
  assert.match(failedRaw, /Parser-breaking fixture/);
  assert.match(first.manifest.categories[0].index!.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.categories[0].index!.parserVersion, "next-dnd-2024-v1");

  const offline = await collectNextDndSnapshots({
    outputDirectory,
    categories: ["spells"],
    offline: true,
    fetch: async () => { throw new Error("network must not run"); },
    now,
  });
  assert.equal(offline.runDirectory, first.runDirectory);
  assert.deepEqual(offline.manifest, first.manifest);

  const fallback = await collectNextDndSnapshots({
    outputDirectory,
    categories: ["spells"],
    refresh: true,
    retries: 1,
    minimumDelayMs: 0,
    fetch: async () => { throw new Error("upstream unavailable"); },
    now,
    sleep: async () => undefined,
  });
  assert.equal(fallback.runDirectory, first.runDirectory);
  assert.deepEqual(fallback.manifest, first.manifest);
  assert.deepEqual(JSON.parse(await readFile(join(first.runDirectory, "category-discovery.json"), "utf8")), [{
    requestedCategory: "spells", discoveredCategory: "spells", entryCount: 2, collectedDetailCount: 1,
  }]);
  assert.equal(JSON.parse(await readFile(join(first.runDirectory, "parser-failures.json"), "utf8")).length, 1);
});

test("offline cache misses produce a stable fetch failure report without deleting prior data", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "next-dnd-offline-"));
  const result = await collectNextDndSnapshots({
    outputDirectory,
    categories: ["spells"],
    offline: true,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  assert.equal(result.manifest.categories[0].index, null);
  assert.equal(result.manifest.parserFailures[0].phase, "fetch");
  assert.match(result.manifest.parserFailures[0].message, /offline mode/);
});
