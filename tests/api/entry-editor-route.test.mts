import assert from "node:assert/strict";
import test from "node:test";

import { mapEntryEditorError } from "../../src/server/compendium/entry-editor-http.ts";
import { CompendiumValidationError } from "../../src/server/compendium/service.ts";
import { assertSameOriginMutation, OriginValidationError } from "../../src/server/http/same-origin.ts";

test("editor mutations require exact same-origin requests", () => {
  assert.doesNotThrow(()=>assertSameOriginMutation(new Request("https://dnd.example/api/admin/compendium/entries",{method:"POST",headers:{Origin:"https://dnd.example"}})));
  assert.doesNotThrow(()=>assertSameOriginMutation(new Request("http://internal:3000/api/admin/compendium/entries",{method:"POST",headers:{Origin:"https://dnd.example",Host:"dnd.example","X-Forwarded-Proto":"https"}})));
  assert.throws(()=>assertSameOriginMutation(new Request("https://dnd.example/api/admin/compendium/entries",{method:"POST",headers:{Origin:"https://evil.example"}})),OriginValidationError);
  assert.throws(()=>assertSameOriginMutation(new Request("http://internal:3000/api/admin/compendium/entries",{method:"POST",headers:{Origin:"https://dnd.example",Host:"dnd.example","X-Forwarded-Proto":"https,http"}})),OriginValidationError);
});

test("stale correction validation maps to an HTTP conflict", () => {
  assert.deepEqual(mapEntryEditorError(new CompendiumValidationError("The entry changed after this editor was opened.")),{status:409,message:"The entry changed after this editor was opened."});
});
