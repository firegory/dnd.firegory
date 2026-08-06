import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { collectNextDndSnapshots, type NextDndNetworkRequest } from "../../src/server/compendium/next-dnd/collector.ts";
import { spellDetailFixture, spellIndexFixture } from "../fixtures/next-dnd/spells.mts";

const now = () => new Date("2026-08-06T12:00:00.000Z");
const publicDns = async () => ["93.184.216.34"];
const robotsAllowed = "User-agent: *\nAllow: /\n";

test("collects raw bytes, honors Retry-After, reports parse failures, and replays cache idempotently", async () => {
  const outputDirectory = await temporaryDirectory("snapshot");
  const attempts = new Map<string, number>();
  const sleeps: number[] = [];
  const requestOptions: Parameters<NextDndNetworkRequest>[1][] = [];
  const fetcher: NextDndNetworkRequest = async (input, init) => {
    const url = String(input);
    requestOptions.push(init ?? {});
    const count = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, count);
    if (url.endsWith("/robots.txt")) return new Response(robotsAllowed, { status: 200 });
    if (url.endsWith("/spells/")) return new Response(spellIndexFixture(2), { status: 200 });
    const externalId = url.match(/\/spells\/(\d+)/)?.[1] ?? "missing";
    if (externalId === "10195" && count === 1) return new Response("busy", { status: 503, statusText: "Busy", headers: { "retry-after": "2" } });
    return new Response(spellDetailFixture(externalId, externalId === "10195"), { status: 200 });
  };

  const first = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 1,
    networkRequest: fetcher,
    resolveHostname: publicDns,
    now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(first.manifest.status, "partial");
  assert.equal(first.manifest.robots?.evaluations.length, 3);
  assert.equal(first.manifest.categories[0].entryCount, 2);
  assert.equal(first.manifest.categories[0].details.length, 1);
  assert.equal(first.manifest.parserFailures[0].phase, "parse");
  assert.ok(first.manifest.parserFailures[0].snapshot);
  assert.ok(sleeps.includes(2_000), "Retry-After seconds must override exponential backoff");
  assert.equal(attempts.get("https://next.dnd.su/spells/10195-hunters-mark"), 2);
  assert.ok(requestOptions.every((init) => init.redirect === "manual" && init.signal instanceof AbortSignal
    && init.pinnedAddress === "93.184.216.34" && init.tlsServerName === "next.dnd.su" && init.hostHeader === "next.dnd.su"));

  const indexSnapshot = first.manifest.categories[0].index!;
  const rawIndex = await readFile(join(outputDirectory, indexSnapshot.blobPath));
  assert.match(rawIndex.toString("utf8"), /window\.LIST/);
  assert.equal(indexSnapshot.byteLength, rawIndex.byteLength);
  assert.equal(indexSnapshot.sha256, createHash("sha256").update(rawIndex).digest("hex"));
  const failedRaw = await readFile(join(outputDirectory, first.manifest.parserFailures[0].snapshot!.blobPath), "utf8");
  assert.match(failedRaw, /Parser-breaking fixture/);

  const offline = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: false,
    categories: ["spells"],
    offline: true,
    networkRequest: async () => { throw new Error("network must not run"); },
    resolveHostname: async () => { throw new Error("DNS must not run"); },
    now,
  });
  assert.equal(offline.runDirectory, first.runDirectory);
  assert.deepEqual(offline.manifest, first.manifest);

  const fallback = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    refresh: true,
    retries: 1,
    minimumDelayMs: 1,
    networkRequest: async (url) => {
      if (url.pathname === "/robots.txt") return new Response(robotsAllowed);
      throw new Error("upstream unavailable");
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.equal(fallback.manifest.status, "partial");
  assert.ok(fallback.manifest.diagnostics.length >= 3);
  assert.ok(fallback.manifest.diagnostics.every((diagnostic) => diagnostic.code === "stale-cache-fallback" && diagnostic.attempts === 2));
  assert.notEqual(fallback.runDirectory, first.runDirectory);
  assert.equal(JSON.parse(await readFile(join(fallback.runDirectory, "collection-diagnostics.json"), "utf8")).length, fallback.manifest.diagnostics.length);
});

test("refreshes robots first online and never authorizes from stale robots", async () => {
  const outputDirectory = await temporaryDirectory("fresh-robots");
  await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async (url) => {
      if (url.pathname === "/robots.txt") return new Response(robotsAllowed);
      if (url.pathname === "/spells/") return new Response(spellIndexFixture(1));
      return new Response(spellDetailFixture("10195"));
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });

  const failedRequests: string[] = [];
  const failedRefresh = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async (url) => { failedRequests.push(url.href); throw new Error("robots unavailable"); },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.deepEqual(failedRequests, ["https://next.dnd.su/robots.txt"]);
  assert.equal(failedRefresh.manifest.status, "failed");
  assert.equal(failedRefresh.manifest.robots, null);
  assert.deepEqual(failedRefresh.manifest.diagnostics, [], "stale robots must never be a network authorization fallback");

  const changedRequests: string[] = [];
  const changedPolicy = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async (url) => {
      changedRequests.push(url.href);
      return new Response("User-agent: *\nDisallow: /spells/\n");
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.deepEqual(changedRequests, ["https://next.dnd.su/robots.txt"]);
  assert.equal(changedPolicy.manifest.parserFailures[0].phase, "policy");
});

test("collector API requires explicit network consent and a positive rate limit", async () => {
  const outputDirectory = await temporaryDirectory("consent");
  await assert.rejects(collectNextDndSnapshots({ outputDirectory, allowNetwork: false, categories: ["spells"] }), /Network consent is required/);
  await assert.rejects(collectNextDndSnapshots({ outputDirectory, allowNetwork: true, categories: ["spells"], minimumDelayMs: 0 }), /minimumDelayMs/);
  await assert.rejects(collectNextDndSnapshots({ outputDirectory, allowNetwork: true, offline: true, categories: ["spells"] }), /allowNetwork=false/);
});

test("enforces robots.txt and records policy evidence before category requests", async () => {
  const outputDirectory = await temporaryDirectory("robots");
  const requested: string[] = [];
  const result = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async (input) => {
      requested.push(String(input));
      return new Response("User-agent: *\nDisallow: /*ells/$\n", { status: 200 });
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.deepEqual(requested, ["https://next.dnd.su/robots.txt"]);
  assert.equal(result.manifest.status, "partial");
  assert.deepEqual(result.manifest.robots?.evaluations, [{ sourceUrl: "https://next.dnd.su/spells/", allowed: false }]);
  assert.equal(result.manifest.parserFailures[0].phase, "policy");
});

test("rejects a discovered LIST category that differs from the requested category", async () => {
  const requested: string[] = [];
  const result = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("category-mismatch"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async (url) => {
      requested.push(url.href);
      if (url.pathname === "/robots.txt") return new Response(robotsAllowed);
      return new Response(spellIndexFixture(1).replace('"category":"spells"', '"category":"items"'));
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.deepEqual(requested, ["https://next.dnd.su/robots.txt", "https://next.dnd.su/spells/"]);
  assert.equal(result.manifest.status, "partial");
  assert.match(result.manifest.parserFailures[0].message, /category "items" does not match requested category "spells"/);
});

test("follows only bounded manual redirects after validating each target", async () => {
  const outputDirectory = await temporaryDirectory("redirect");
  const requested: string[] = [];
  let dnsChecks = 0;
  const result = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    maxRedirects: 2,
    networkRequest: async (input, init) => {
      const url = String(input);
      requested.push(url);
      assert.equal(init?.redirect, "manual");
      if (url.endsWith("/robots.txt")) return new Response(robotsAllowed);
      if (url.endsWith("/spells/")) return new Response(null, { status: 302, headers: { location: "/spells/?all=1" } });
      if (url.includes("?all=1")) return new Response(spellIndexFixture(1));
      return new Response(spellDetailFixture("10195"));
    },
    resolveHostname: async () => { dnsChecks++; return ["93.184.216.34"]; },
    now,
    sleep: async () => undefined,
  });
  assert.equal(result.manifest.status, "complete");
  assert.equal(result.manifest.categories[0].index?.finalUrl, "https://next.dnd.su/spells/?all=1");
  assert.deepEqual(result.manifest.categories[0].index?.redirectChain, ["https://next.dnd.su/spells/?all=1"]);
  assert.ok(dnsChecks >= requested.length, "every requested and redirected target must receive DNS validation");

  for (const [label, location] of [["scheme", "http://next.dnd.su/private"], ["host", "https://evil.test/private"]]) {
    const rejected = await collectNextDndSnapshots({
      outputDirectory: await temporaryDirectory(`redirect-${label}`),
      allowNetwork: true,
      categories: ["spells"],
      minimumDelayMs: 1,
      retries: 0,
      networkRequest: async (input) => String(input).endsWith("robots.txt")
        ? new Response(robotsAllowed)
        : new Response(null, { status: 302, headers: { location } }),
      resolveHostname: publicDns,
      now,
      sleep: async () => undefined,
    });
    assert.match(rejected.manifest.parserFailures[0].message, /credential-free HTTPS URLs on next\.dnd\.su/);
  }

  let redirectRequests = 0;
  let redirectDnsChecks = 0;
  const privateRedirect = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("redirect-private"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async (input) => {
      redirectRequests++;
      return String(input).endsWith("robots.txt")
        ? new Response(robotsAllowed)
        : new Response(null, { status: 302, headers: { location: "/spells/?private=1" } });
    },
    resolveHostname: async () => [++redirectDnsChecks >= 3 ? "127.0.0.1" : "93.184.216.34"],
    now,
    sleep: async () => undefined,
  });
  assert.equal(redirectRequests, 2, "the private redirect target must not be requested");
  assert.match(privateRedirect.manifest.parserFailures[0].message, /not a public IP/);

  const bounded = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("redirect-limit"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    maxRedirects: 1,
    networkRequest: async (input) => String(input).endsWith("robots.txt")
      ? new Response(robotsAllowed)
      : new Response(null, { status: 302, headers: { location: `/spells/?next=${encodeURIComponent(String(input))}` } }),
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.match(bounded.manifest.parserFailures[0].message, /Redirect limit/);
});

test("rejects private DNS targets before making a request", async () => {
  let requests = 0;
  const result = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("private-dns"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 3,
    networkRequest: async () => { requests++; return new Response(robotsAllowed); },
    resolveHostname: async () => ["127.0.0.1", "93.184.216.34"],
    now,
    sleep: async () => undefined,
  });
  assert.equal(requests, 0);
  assert.equal(result.manifest.status, "failed");
  assert.match(result.manifest.parserFailures[0].message, /not a public IP/);
});

test("pins the validated public address when ambient DNS changes before connect", async () => {
  let ambientDnsAnswer = "93.184.216.34";
  const connectedAddresses: string[] = [];
  const result = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("dns-pin"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    resolveHostname: async () => {
      const validated = ambientDnsAnswer;
      ambientDnsAnswer = "127.0.0.1";
      return [validated === "127.0.0.1" ? "93.184.216.34" : validated];
    },
    networkRequest: async (url, options) => {
      assert.equal(ambientDnsAnswer, "127.0.0.1");
      assert.equal(options.pinnedAddress, "93.184.216.34");
      assert.equal(options.tlsServerName, "next.dnd.su");
      assert.equal(options.hostHeader, "next.dnd.su");
      connectedAddresses.push(options.pinnedAddress);
      if (url.pathname === "/robots.txt") return new Response(robotsAllowed);
      if (url.pathname === "/spells/") return new Response(spellIndexFixture(1));
      return new Response(spellDetailFixture("10195"));
    },
    now,
    sleep: async () => undefined,
  });
  assert.equal(result.manifest.status, "complete");
  assert.deepEqual(connectedAddresses, ["93.184.216.34", "93.184.216.34", "93.184.216.34"]);
});

test("aborts timed-out requests and caps streamed response bytes", async () => {
  let receivedSignal: AbortSignal | null = null;
  const timeoutResult = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("timeout"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    requestTimeoutMs: 100,
    networkRequest: async (_input, init) => {
      receivedSignal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => receivedSignal!.addEventListener("abort", () => reject(receivedSignal!.reason), { once: true }));
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.equal(receivedSignal?.aborted, true);
  assert.match(timeoutResult.manifest.parserFailures[0].message, /timed out/);

  const capped = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("cap"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    maxResponseBytes: 1_024,
    networkRequest: async (input) => String(input).endsWith("robots.txt") ? new Response(robotsAllowed) : new Response("x".repeat(1_025)),
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.match(capped.manifest.parserFailures[0].message, /exceeds 1024 bytes/);
});

test("does not retry permanent HTTP failures", async () => {
  let detailAttempts = 0;
  const result = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("permanent"),
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 5,
    networkRequest: async (input) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response(robotsAllowed);
      if (url.endsWith("/spells/")) return new Response(spellIndexFixture(1));
      detailAttempts++;
      return new Response("missing", { status: 404, statusText: "Not Found" });
    },
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.equal(detailAttempts, 1);
  assert.match(result.manifest.parserFailures[0].message, /HTTP 404/);
});

test("rejects corrupted existing content-addressed blob bytes", async () => {
  const outputDirectory = await temporaryDirectory("blob-integrity");
  const expectedHash = createHash("sha256").update(Buffer.from(robotsAllowed)).digest("hex");
  const blobPath = join(outputDirectory, "blobs", `${expectedHash}.html`);
  await mkdir(dirname(blobPath), { recursive: true });
  await writeFile(blobPath, "different bytes");
  const result = await collectNextDndSnapshots({
    outputDirectory,
    allowNetwork: true,
    categories: ["spells"],
    minimumDelayMs: 1,
    retries: 0,
    networkRequest: async () => new Response(robotsAllowed),
    resolveHostname: publicDns,
    now,
    sleep: async () => undefined,
  });
  assert.equal(result.manifest.status, "failed");
  assert.match(result.manifest.parserFailures[0].message, /content-addressed blob failed byte\/hash verification/);
});

test("offline cache misses produce a failed report without network or DNS", async () => {
  const result = await collectNextDndSnapshots({
    outputDirectory: await temporaryDirectory("offline"),
    allowNetwork: false,
    categories: ["spells"],
    offline: true,
    now,
  });
  assert.equal(result.manifest.status, "failed");
  assert.equal(result.manifest.parserFailures[0].stage, "robots");
  assert.match(result.manifest.parserFailures[0].message, /offline mode/);
});

async function temporaryDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `next-dnd-${label}-`));
}
