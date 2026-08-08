import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("authorized compendium details provide an exact reusable ask scope", async () => {
  const page = await readFile("src/app/[locale]/compendium/entries/[identifier]/page.tsx", "utf8");
  const component = await readFile("src/components/compendium/ask-about-entry.tsx", "utf8");

  assert.match(page, /<AskAboutEntry/);
  for (const value of ["entry.id", "entry.source.id", "entry.versionId", "entry.edition", "entry.language"]) {
    assert.match(page, new RegExp(value.replace(".", "\\.")));
  }
  assert.match(component, /fetch\("\/api\/answer"/);
  assert.match(component, /JSON\.stringify\(\{ query: question, answerLanguage: locale, entryScope: scope \}\)/);
  assert.doesNotMatch(component, /localStorage|sourceLanguage|category/);
});

test("ask-about-entry form exposes labels, busy state, and live results", async () => {
  const component = await readFile("src/components/compendium/ask-about-entry.tsx", "utf8");
  assert.match(component, /htmlFor=\{inputId\}/);
  assert.match(component, /aria-busy=\{loading\}/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /disabled=\{loading \|\| !query\.trim\(\)\}/);
});
