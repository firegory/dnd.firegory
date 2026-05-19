import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildRetrievalAuthorizationFilter,
  sourceMatchesRetrievalAuthorizationFilter,
  type SourceAccessMetadata,
} from "../../src/server/access/retrieval-filter.ts";

describe("search filter enforcement", () => {
  const openSource: SourceAccessMetadata = {
    edition: "5e",
    language: "en",
    category: "core_rules",
    accessTier: "open",
  };

  const premiumSource: SourceAccessMetadata = {
    edition: "5e",
    language: "en",
    category: "official_supplement",
    accessTier: "premium",
    shared: true,
  };

  const personalSource: SourceAccessMetadata = {
    edition: "5e",
    language: "en",
    category: "homebrew",
    accessTier: "personal",
    ownerUserId: "user-123",
  };

  it("regular user can only see open sources", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user", userId: "user-123" },
      {},
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filter));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(premiumSource, filter));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(personalSource, filter));
  });

  it("premium user can see open and shared premium sources", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "user-123" },
      {},
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filter));
    assert.ok(sourceMatchesRetrievalAuthorizationFilter(premiumSource, filter));
    // personalSource is owned by user-123, so this premium user CAN see it
    assert.ok(sourceMatchesRetrievalAuthorizationFilter(personalSource, filter));
  });

  it("premium user can see own personal sources", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "user-123" },
      {},
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(personalSource, filter));
  });

  it("premium user cannot see other users' personal sources", () => {
    const othersPersonal: SourceAccessMetadata = {
      edition: "5e",
      language: "en",
      category: "homebrew",
      accessTier: "personal",
      ownerUserId: "user-456",
    };

    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "user-123" },
      {},
    );

    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(othersPersonal, filter));
  });

  it("admin can see all sources", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "admin", userId: "admin-1" },
      {},
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filter));
    assert.ok(sourceMatchesRetrievalAuthorizationFilter(premiumSource, filter));
    assert.ok(sourceMatchesRetrievalAuthorizationFilter(personalSource, filter));
  });

  it("edition filter narrows results", () => {
    const source55: SourceAccessMetadata = {
      edition: "5.5e",
      language: "en",
      category: "core_rules",
      accessTier: "open",
    };

    const filter5e = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { edition: "5e" },
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filter5e));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(source55, filter5e));
  });

  it("language filter narrows results", () => {
    const ruSource: SourceAccessMetadata = {
      edition: "5e",
      language: "ru",
      category: "core_rules",
      accessTier: "open",
    };

    const filterEn = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { language: "en" },
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filterEn));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(ruSource, filterEn));
  });

  it("combined filters narrow on all dimensions", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "user-123" },
      { edition: "5e", language: "en", category: "core_rules" },
    );

    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filter));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(premiumSource, filter));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(personalSource, filter));
  });
});
