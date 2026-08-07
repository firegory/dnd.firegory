import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatedRedirectPath } from "../../src/server/http/redirect-path.ts";
import { uiLocaleForPathname } from "../../src/server/http/ui-locale.ts";

test("login destinations preserve local path, query, and fragments", () => {
  assert.equal(validatedRedirectPath("/en/compendium/entries/id?tab=rules#casting"), "/en/compendium/entries/id?tab=rules#casting");
  assert.equal(validatedRedirectPath("/ru/compendium#basics"), "/ru/compendium#basics");
});

test("login destinations reject open redirects and malformed paths", () => {
  for (const value of ["https://evil.test/x", "//evil.test/x", "/\\evil.test/x", "javascript:alert(1)", "/ok\r\nLocation: https://evil.test", null]) {
    assert.equal(validatedRedirectPath(value), "/");
  }
});

test("middleware, form, and action carry the validated destination", async () => {
  const [middleware, page, form, action, session] = await Promise.all([
    readFile(new URL("../../src/middleware.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/login/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/login/login-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/auth/actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/auth/session.ts", import.meta.url), "utf8"),
  ]);
  assert.match(middleware, /pathname.*request\.nextUrl\.search/);
  assert.match(page, /validatedRedirectPath/);
  assert.match(form, /type="hidden" name="next" value=\{nextPath\}/);
  assert.match(action, /validatedRedirectPath\(formData\.get\("next"\)\)[\s\S]*redirect\(nextPath\)/);
  assert.match(session, /x-dnd-request-path[\s\S]*\/login\?next=/);
});

test("locale paths drive the server-rendered document language", async () => {
  assert.equal(uiLocaleForPathname("/en/compendium"), "en");
  assert.equal(uiLocaleForPathname("/ru/compendium/guides/starter"), "ru");
  assert.equal(uiLocaleForPathname("/login"), "ru");
  const layout = await readFile(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /x-dnd-ui-language/);
  assert.match(layout, /<html lang=\{language\}>/);
});
