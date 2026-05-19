import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateEnum,
  validateIngestionArgs,
  VALID_CATEGORIES,
  VALID_EDITIONS,
  VALID_LANGUAGES,
  VALID_ACCESS_TIERS,
} from "../../src/cli/validate-args.ts";

// ── validateEnum ─────────────────────────────────────────────────────

describe("validateEnum", () => {
  it("returns the value when valid", () => {
    assert.strictEqual(validateEnum("5e", VALID_EDITIONS, "--edition"), "5e");
    assert.strictEqual(validateEnum("core_rules", VALID_CATEGORIES, "--category"), "core_rules");
    assert.strictEqual(validateEnum("en", VALID_LANGUAGES, "--language"), "en");
    assert.strictEqual(validateEnum("open", VALID_ACCESS_TIERS, "--access"), "open");
  });

  it("throws on invalid value", () => {
    assert.throws(
      () => validateEnum("invalid", VALID_EDITIONS, "--edition"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--edition must be one of/);
        assert.match(err.message, /Got: "invalid"/);
        return true;
      },
    );
  });

  it("throws with correct label in message", () => {
    assert.throws(
      () => validateEnum("4e", VALID_EDITIONS, "--edition"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--edition/);
        return true;
      },
    );
  });

  it("accepts all valid categories", () => {
    for (const cat of VALID_CATEGORIES) {
      assert.strictEqual(validateEnum(cat, VALID_CATEGORIES, "--category"), cat);
    }
  });

  it("accepts all valid editions", () => {
    for (const ed of VALID_EDITIONS) {
      assert.strictEqual(validateEnum(ed, VALID_EDITIONS, "--edition"), ed);
    }
  });

  it("accepts all valid languages", () => {
    for (const lang of VALID_LANGUAGES) {
      assert.strictEqual(validateEnum(lang, VALID_LANGUAGES, "--language"), lang);
    }
  });

  it("accepts all valid access tiers", () => {
    for (const tier of VALID_ACCESS_TIERS) {
      assert.strictEqual(validateEnum(tier, VALID_ACCESS_TIERS, "--access"), tier);
    }
  });
});

// ── validateIngestionArgs ────────────────────────────────────────────

const VALID_INPUT = {
  pdf: "/path/to/book.pdf",
  title: "Player's Handbook",
  category: "core_rules",
  edition: "5e",
  language: "en",
  access: "open",
};

describe("validateIngestionArgs", () => {
  it("returns typed args for valid input", () => {
    const result = validateIngestionArgs(VALID_INPUT);
    assert.strictEqual(result.pdf, "/path/to/book.pdf");
    assert.strictEqual(result.title, "Player's Handbook");
    assert.strictEqual(result.category, "core_rules");
    assert.strictEqual(result.edition, "5e");
    assert.strictEqual(result.language, "en");
    assert.strictEqual(result.access, "open");
    assert.strictEqual(result.ownerUserId, undefined);
  });

  it("accepts optional ownerUserId", () => {
    const result = validateIngestionArgs({
      ...VALID_INPUT,
      ownerUserId: "user-uuid-123",
    });
    assert.strictEqual(result.ownerUserId, "user-uuid-123");
  });

  it("accepts 5.5e edition", () => {
    const result = validateIngestionArgs({ ...VALID_INPUT, edition: "5.5e" });
    assert.strictEqual(result.edition, "5.5e");
  });

  it("accepts ru language", () => {
    const result = validateIngestionArgs({ ...VALID_INPUT, language: "ru" });
    assert.strictEqual(result.language, "ru");
  });

  it("accepts all access tiers", () => {
    for (const tier of ["open", "premium", "personal"] as const) {
      const result = validateIngestionArgs({ ...VALID_INPUT, access: tier });
      assert.strictEqual(result.access, tier);
    }
  });

  it("accepts all categories", () => {
    for (const cat of ["core_rules", "official_supplement", "homebrew"] as const) {
      const result = validateIngestionArgs({ ...VALID_INPUT, category: cat });
      assert.strictEqual(result.category, cat);
    }
  });

  it("throws when pdf is missing", () => {
    const { pdf: _pdf, ...noPdf } = VALID_INPUT;
    assert.throws(
      () => validateIngestionArgs(noPdf),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--pdf/);
        return true;
      },
    );
  });

  it("throws when title is missing", () => {
    const { title: _title, ...noTitle } = VALID_INPUT;
    assert.throws(
      () => validateIngestionArgs(noTitle),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--title/);
        return true;
      },
    );
  });

  it("throws when all required options are missing", () => {
    assert.throws(
      () => validateIngestionArgs({}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--pdf.*--title.*--category.*--edition.*--language.*--access/);
        return true;
      },
    );
  });

  it("throws on invalid category", () => {
    assert.throws(
      () => validateIngestionArgs({ ...VALID_INPUT, category: "invalid_cat" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--category must be one of/);
        return true;
      },
    );
  });

  it("throws on invalid edition", () => {
    assert.throws(
      () => validateIngestionArgs({ ...VALID_INPUT, edition: "4e" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--edition must be one of/);
        return true;
      },
    );
  });

  it("throws on invalid language", () => {
    assert.throws(
      () => validateIngestionArgs({ ...VALID_INPUT, language: "de" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--language must be one of/);
        return true;
      },
    );
  });

  it("throws on invalid access tier", () => {
    assert.throws(
      () => validateIngestionArgs({ ...VALID_INPUT, access: "admin" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /--access must be one of/);
        return true;
      },
    );
  });
});
