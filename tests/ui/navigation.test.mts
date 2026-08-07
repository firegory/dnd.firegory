import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getNavigationItems, isNavigationItemActive } from "../../src/components/ui/navigation.ts";
import { readFile } from "node:fs/promises";

describe("compendium navigation", () => {
  it("keeps search and settings reachable for every authenticated role", () => {
    for (const role of [undefined, "user", "premium", "admin"] as const) {
      const routes = getNavigationItems(role).map((item) => item.href);
      assert.ok(routes.includes("/ru/compendium"));
      assert.ok(routes.includes("/search"));
      assert.ok(routes.includes("/settings"));
    }
    assert.equal(getNavigationItems("user", "en")[0].href, "/en/compendium");
  });

  it("adds all existing administration routes only for administrators", () => {
    assert.deepEqual(
      getNavigationItems("admin").map((item) => item.href),
      ["/ru/compendium", "/search", "/spells", "/classes", "/species", "/settings", "/admin/sources", "/admin/ingestion", "/admin/compendium/imports", "/admin/compendium/entries", "/admin/users"],
    );
    assert.equal(getNavigationItems("user").some((item) => item.href.startsWith("/admin")), false);
  });

  it("marks route descendants active without matching similar route names", () => {
    assert.equal(isNavigationItemActive("/admin/sources/id-1", "/admin/sources"), true);
    assert.equal(isNavigationItemActive("/search", "/search"), true);
    assert.equal(isNavigationItemActive("/searching", "/search"), false);
  });

  it("switches locale in place without dropping query or hash state", async () => {
    const sidebar = await readFile(new URL("../../src/components/ui/sidebar.tsx", import.meta.url), "utf8");
    assert.match(sidebar, /pathname\.replace[\s\S]*window\.location\.search[\s\S]*window\.location\.hash/);
  });
});
