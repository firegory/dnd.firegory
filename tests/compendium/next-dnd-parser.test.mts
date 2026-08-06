import assert from "node:assert/strict";
import test from "node:test";

import { parseNextDndDetail, parseNextDndIndex } from "../../src/server/compendium/next-dnd/parser.ts";
import { spellDetailFixture, spellIndexFixture, storedXssDetailFixture } from "../fixtures/next-dnd/spells.mts";

test("parses the current 411-spell window.LIST shape without a browser", () => {
  const parsed = parseNextDndIndex(spellIndexFixture(), "https://next.dnd.su/spells/", "spells");
  assert.equal(parsed.category, "spells");
  assert.equal(parsed.entries.length, 411);
  assert.deepEqual(parsed.order, { title: "Название", level: "Уровень", school: "Школа" });
  assert.deepEqual(parsed.entries[0], {
    category: "spells",
    externalId: "10195",
    sourceUrl: "https://next.dnd.su/spells/10195-hunters-mark",
    title: "Метка охотника",
    titleEn: "Hunter's Mark",
    metadata: parsed.entries[0].metadata,
  });
  assert.equal(parsed.entries[0].metadata.filter_source instanceof Array, true);
});

test("extracts only detail card content and excludes page chrome", () => {
  const parsed = parseNextDndDetail(spellDetailFixture("10195"), "spells", "10195");
  assert.equal(parsed.title, "Fixture Spell [Fixture Spell]");
  assert.match(parsed.contentText, /Rules text retained/);
  for (const excluded of ["Site navigation", "Password", "Comment must", "Partner must", "Card navigation", "Edit navigation"]) {
    assert.doesNotMatch(parsed.contentText, new RegExp(excluded));
    assert.doesNotMatch(parsed.contentHtml, new RegExp(excluded));
  }
});

test("rejects executable LIST values and off-category links", () => {
  assert.throws(() => parseNextDndIndex("<script>window.LIST = makeList();</script>", "https://next.dnd.su/spells/", "spells"), /JSON object/);
  const html = '<script>window.LIST={"cards":[{"title":"Bad","link":"/comments/1-bad"}],"category":"spells"};</script>';
  assert.throws(() => parseNextDndIndex(html, "https://next.dnd.su/spells/", "spells"), /outside \/spells\//);
  const mismatch = spellIndexFixture(1).replace('"category":"spells"', '"category":"items"');
  assert.throws(() => parseNextDndIndex(mismatch, "https://next.dnd.su/spells/", "spells"), /does not match requested category/);
});

test("sanitizes stored-XSS payloads with tag, attribute, and protocol allowlists", () => {
  const parsed = parseNextDndDetail(storedXssDetailFixture("10195"), "spells", "10195");
  assert.match(parsed.contentHtml, /Retained rules/);
  assert.match(parsed.contentHtml, /href="https:\/\/example\.com\/rule"/);
  for (const unsafe of ["javascript:", "onclick", "onmouseover", "onerror", "style=", "<script", "<svg", "<iframe", "srcdoc", "<img", "<object", "<embed", "<link", "<form", "<input", "target=", "rel="]) {
    assert.doesNotMatch(parsed.contentHtml.toLowerCase(), new RegExp(unsafe));
  }
});

test("requires an exact detail category and external ID", () => {
  assert.throws(() => parseNextDndDetail(spellDetailFixture("10195"), "items", "10195"), /exact card items:10195/);
  assert.throws(() => parseNextDndDetail(spellDetailFixture("101950"), "spells", "10195"), /exact card spells:10195/);
});
