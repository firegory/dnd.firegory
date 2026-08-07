import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("src/app/admin/compendium/entries/editor-client.tsx","utf8");
const selectionSource = await readFile("src/app/admin/compendium/entries/entry-selection.ts","utf8");

test("entry editor exposes responsive, localized, accessible structured controls",()=>{
  assert.match(source,/COPY = \{/);
  assert.match(source,/ru: \{/);
  assert.match(source,/en: \{/);
  assert.match(source,/role="alert"/);
  assert.match(source,/role="status"/);
  assert.match(source,/aria-label=.*block\.type/);
  assert.match(source,/sm:grid-cols-2/);
  assert.match(source,/lg:grid-cols-2/);
  assert.doesNotMatch(source,/dangerouslySetInnerHTML/);
});

test("cancel is local-only and evidence has preview and exact code-point spans",()=>{
  const cancelBody=/function cancel\(\)\{[^}]*\}/.exec(source)?.[0]??"";
  assert.doesNotMatch(cancelBody,/fetch|json\(/);
  assert.match(source,/quoteSpanEnd:Array\.from\(chunk\.quote\)\.length/);
  assert.match(source,/api\/citations\/preview/);
  assert.match(source,/expectedActiveRevisionId:detail\.canonicalRevisionId/);
  assert.match(source,/detailController\.current\?\.abort\(\)/);
  assert.match(source,/shouldApplyDetailResponse/);
  assert.match(selectionSource,/requestSequence === input\.currentSequence/);
  assert.match(source,/aria-busy=\{detailLoading\}/);
  assert.match(source,/aria-live="polite"/);
  assert.match(source,/basedOnRevisionId:detail\.editorHeadRevisionId/);
  assert.match(source,/setDetail\(null\);setForm\(blankForm\(\)\)/);
  assert.match(source,/actionsDisabled=busy\|\|detailLoading\|\|!detailCurrent/);
});
