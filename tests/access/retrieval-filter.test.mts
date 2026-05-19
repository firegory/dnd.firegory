import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRetrievalAuthorizationFilter,
  sourceMatchesRetrievalAuthorizationFilter,
  type SourceAccessMetadata,
} from "../../src/server/access/retrieval-filter.ts";

test("user filters allow only open/SRD sources and include selected corpus filters", () => {
  const filter = buildRetrievalAuthorizationFilter(
    { role: "user", userId: "user-1" },
    { edition: "5e", language: "en", category: "core_rules" },
  );

  assert.deepEqual(filter, {
    edition: "5e",
    language: "en",
    category: "core_rules",
    access: { kind: "anyOf", clauses: [{ accessTier: "open" }] },
  });

  assert.equal(
    sourceMatchesRetrievalAuthorizationFilter(
      source({ accessTier: "open", edition: "5e", language: "en", category: "core_rules" }),
      filter,
    ),
    true,
  );
  assert.equal(
    sourceMatchesRetrievalAuthorizationFilter(
      source({ accessTier: "premium", shared: true, edition: "5e", language: "en", category: "core_rules" }),
      filter,
    ),
    false,
  );
  assert.equal(
    sourceMatchesRetrievalAuthorizationFilter(
      source({ accessTier: "open", edition: "5.5e", language: "en", category: "core_rules" }),
      filter,
    ),
    false,
  );
});

test("premium filters allow open, shared premium, and owned personal sources", () => {
  const filter = buildRetrievalAuthorizationFilter(
    { role: "premium", userId: "premium-1" },
    { edition: "5.5e", language: "ru" },
  );

  assert.deepEqual(filter.access, {
    kind: "anyOf",
    clauses: [
      { accessTier: "open" },
      { accessTier: "premium", shared: true },
      { accessTier: "personal", ownerUserId: "premium-1" },
    ],
  });

  assert.equal(matches({ accessTier: "open" }, filter), true);
  assert.equal(matches({ accessTier: "premium", shared: true }, filter), true);
  assert.equal(matches({ accessTier: "premium", shared: false }, filter), false);
  assert.equal(matches({ accessTier: "personal", ownerUserId: "premium-1" }, filter), true);
  assert.equal(matches({ accessTier: "personal", ownerUserId: "other-user" }, filter), false);
});

test("premium filters do not include personal content when server context has no user id", () => {
  const filter = buildRetrievalAuthorizationFilter({ role: "premium" });

  assert.deepEqual(filter.access, {
    kind: "anyOf",
    clauses: [{ accessTier: "open" }, { accessTier: "premium", shared: true }],
  });

  assert.equal(matches({ accessTier: "personal", ownerUserId: "premium-1" }, filter), false);
});

test("admin filters can access all source tiers while still honoring corpus filters", () => {
  const filter = buildRetrievalAuthorizationFilter(
    { role: "admin", userId: "admin-1" },
    { language: "ru", category: "homebrew" },
  );

  assert.deepEqual(filter, {
    language: "ru",
    category: "homebrew",
    access: { kind: "all" },
  });

  assert.equal(matches({ accessTier: "open", language: "ru", category: "homebrew" }, filter), true);
  assert.equal(matches({ accessTier: "premium", shared: false, language: "ru", category: "homebrew" }, filter), true);
  assert.equal(matches({ accessTier: "personal", ownerUserId: "other-user", language: "ru", category: "homebrew" }, filter), true);
  assert.equal(matches({ accessTier: "personal", ownerUserId: "other-user", language: "en", category: "homebrew" }, filter), false);
});

function matches(
  partial: Partial<SourceAccessMetadata>,
  filter: ReturnType<typeof buildRetrievalAuthorizationFilter>,
): boolean {
  return sourceMatchesRetrievalAuthorizationFilter(source(partial), filter);
}

function source(partial: Partial<SourceAccessMetadata>): SourceAccessMetadata {
  return {
    accessTier: "open",
    edition: "5.5e",
    language: "ru",
    category: "official_supplement",
    ...partial,
  };
}
