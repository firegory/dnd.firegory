/**
 * Tests for buildSourceAccessSql — the SQL generation layer
 * that converts RetrievalAuthorizationFilter into parameterized WHERE clauses.
 *
 * These tests verify that access control is correctly enforced at the SQL level,
 * which is the primary defense against unauthorized data access in the MVP.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSourceAccessSql } from "../../src/server/access/access-sql.ts";
import {
  buildRetrievalAuthorizationFilter,
} from "../../src/server/access/retrieval-filter.ts";

describe("buildSourceAccessSql — user role access", () => {
  it("generates open-only SQL for regular user", () => {
    const filter = buildRetrievalAuthorizationFilter({ role: "user", userId: "u-1" });
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.access_tier = 'open'"), `Expected open tier condition, got: ${sql}`);
    assert.equal(params.length, 0, "No params for user-level access");
  });

  it("generates open + shared premium + personal SQL for premium user", () => {
    const filter = buildRetrievalAuthorizationFilter({ role: "premium", userId: "p-1" });
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.access_tier = 'open'"));
    assert.ok(sql.includes("s.access_tier = 'premium' AND s.shared = true"));
    assert.ok(sql.includes("s.access_tier = 'personal' AND s.owner_user_id"));
    assert.equal(params.length, 1);
    assert.equal(params[0], "p-1", "ownerUserId should be in params");
  });

  it("generates no access restriction SQL for admin", () => {
    const filter = buildRetrievalAuthorizationFilter({ role: "admin", userId: "a-1" });
    const { sql, params } = buildSourceAccessSql(filter);

    assert.equal(sql, "1=1", "Admin should have unrestricted access SQL");
    assert.equal(params.length, 0);
  });

  it("generates open + shared premium SQL for premium user without userId", () => {
    const filter = buildRetrievalAuthorizationFilter({ role: "premium" });
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.access_tier = 'open'"));
    assert.ok(sql.includes("s.access_tier = 'premium' AND s.shared = true"));
    assert.ok(!sql.includes("personal"), "No personal clause when no userId");
    assert.equal(params.length, 0);
  });
});

describe("buildSourceAccessSql — corpus filters", () => {
  it("adds edition filter as parameterized condition", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { edition: "5e" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.edition = $1"), `Expected edition condition, got: ${sql}`);
    assert.deepEqual(params, ["5e"]);
  });

  it("adds language filter as parameterized condition", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { language: "ru" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.language = $1"));
    assert.deepEqual(params, ["ru"]);
  });

  it("adds category filter as parameterized condition", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { category: "core_rules" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.category = $1"));
    assert.deepEqual(params, ["core_rules"]);
  });

  it("combines multiple corpus filters with AND", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { edition: "5e", language: "en", category: "core_rules" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("AND"), "Conditions should be ANDed together");
    assert.equal(params.length, 3, "Should have 3 params for edition+language+category");
    assert.deepEqual(params, ["5e", "en", "core_rules"]);
  });

  it("combines corpus filters with access filter", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "p-42" },
      { edition: "5.5e", language: "ru" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    // Corpus params come first, then access params
    assert.ok(params.includes("5.5e"), "edition param present");
    assert.ok(params.includes("ru"), "language param present");
    assert.ok(params.includes("p-42"), "ownerUserId param present");
    // Access tier clauses use literals, not params
    assert.ok(sql.includes("s.access_tier = 'open'"));
    assert.ok(sql.includes("s.access_tier = 'premium' AND s.shared = true"));
  });
});

describe("buildSourceAccessSql — edge cases", () => {
  it("produces 1=1 for admin with no corpus filters", () => {
    const filter = buildRetrievalAuthorizationFilter({ role: "admin" });
    const { sql, params } = buildSourceAccessSql(filter);

    assert.equal(sql, "1=1");
    assert.equal(params.length, 0);
  });

  it("admin with corpus filters only has corpus conditions", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "admin" },
      { edition: "5e" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.edition = $1"));
    assert.ok(!sql.includes("access_tier"), "No access tier conditions for admin");
    assert.deepEqual(params, ["5e"]);
  });

  it("uses OR between access clauses for non-admin", () => {
    const filter = buildRetrievalAuthorizationFilter({ role: "premium", userId: "p-1" });
    const { sql } = buildSourceAccessSql(filter);

    const orCount = (sql.match(/ OR /g) ?? []).length;
    assert.ok(orCount >= 2, `Expected at least 2 ORs between 3 clauses, got ${orCount} in: ${sql}`);
  });
});
