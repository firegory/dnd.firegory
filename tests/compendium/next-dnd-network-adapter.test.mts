import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  collectNextDndSnapshots,
  createPinnedHttpsNetworkRequest,
  type NextDndNetworkRequest,
} from "../../src/server/compendium/next-dnd/collector.ts";

for (const status of [204, 205, 304]) {
  test(`pinned HTTPS adapter uses a null body for HTTP ${status}`, async () => {
    const response = await adapterForStatus(status)(new URL("https://next.dnd.su/robots.txt"), requestOptions());
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), "");
  });
}

test("pinned HTTPS adapter rejects Response construction errors", async () => {
  await assert.rejects(
    adapterForStatus(101)(new URL("https://next.dnd.su/robots.txt"), requestOptions()),
    /Pinned HTTPS response construction failed for HTTP 101/,
  );
});

test("collector reports pinned adapter construction failures without crashing", async () => {
  const result = await collectNextDndSnapshots({
    outputDirectory: await mkdtemp(join(tmpdir(), "next-dnd-adapter-")),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: adapterForStatus(101),
    resolveHostname: async () => ["93.184.216.34"],
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    sleep: async () => undefined,
  });
  assert.equal(result.manifest.status, "failed");
  assert.equal(result.manifest.parserFailures[0].stage, "robots");
  assert.match(result.manifest.parserFailures[0].message, /Network request failed: Pinned HTTPS response construction failed for HTTP 101/);
});

function adapterForStatus(status: number): NextDndNetworkRequest {
  return createPinnedHttpsNetworkRequest((_url, _options, onResponse) => ({
    on() { return this; },
    end() {
      const incoming = Readable.from(["unexpected response bytes"]) as IncomingMessage;
      incoming.statusCode = status;
      incoming.statusMessage = "Fixture";
      incoming.headers = { "content-type": "text/plain" };
      queueMicrotask(() => onResponse(incoming));
    },
  }));
}

function requestOptions(): Parameters<NextDndNetworkRequest>[1] {
  return {
    headers: { accept: "text/plain" },
    signal: new AbortController().signal,
    redirect: "manual",
    pinnedAddress: "93.184.216.34",
    tlsServerName: "next.dnd.su",
    hostHeader: "next.dnd.su",
  };
}
