import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getNavigationItems, isNavigationItemActive } from "../../src/components/ui/navigation.ts";

describe("compendium navigation", () => {
  it("keeps search and settings reachable for every authenticated role", () => {
    for (const role of [undefined, "user", "premium", "admin"] as const) {
      const routes = getNavigationItems(role).map((item) => item.href);
      assert.ok(routes.includes("/search"));
      assert.ok(routes.includes("/settings"));
    }
  });

  it("adds all existing administration routes only for administrators", () => {
    assert.deepEqual(
      getNavigationItems("admin").map((item) => item.href),
      ["/search", "/spells", "/settings", "/admin/sources", "/admin/ingestion", "/admin/compendium/imports", "/admin/compendium/entries", "/admin/users"],
    );
    assert.equal(getNavigationItems("user").some((item) => item.href.startsWith("/admin")), false);
  });

  it("marks route descendants active without matching similar route names", () => {
    assert.equal(isNavigationItemActive("/admin/sources/id-1", "/admin/sources"), true);
    assert.equal(isNavigationItemActive("/search", "/search"), true);
    assert.equal(isNavigationItemActive("/searching", "/search"), false);
  });
});
