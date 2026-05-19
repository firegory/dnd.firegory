/**
 * Tests for auth type helpers, admin guards, and role validation.
 *
 * These are pure-function tests that verify the auth type system
 * without requiring database connections.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isUserRole,
  assertAdmin,
  canManageRoles,
  type AuthUser,
} from "../../src/server/auth/types.ts";

describe("auth types: isUserRole", () => {
  it("accepts valid roles", () => {
    assert.equal(isUserRole("user"), true);
    assert.equal(isUserRole("premium"), true);
    assert.equal(isUserRole("admin"), true);
  });

  it("rejects invalid roles", () => {
    assert.equal(isUserRole("superadmin"), false);
    assert.equal(isUserRole("moderator"), false);
    assert.equal(isUserRole(""), false);
    assert.equal(isUserRole("USER"), false);
    assert.equal(isUserRole("Admin"), false);
  });
});

describe("auth types: assertAdmin", () => {
  it("passes for admin user", () => {
    const admin: AuthUser = {
      id: "a-1",
      email: "admin@test.com",
      role: "admin",
      displayName: "Admin",
    };

    // Should not throw
    assertAdmin(admin);
  });

  it("throws for non-admin user", () => {
    const user: AuthUser = {
      id: "u-1",
      email: "user@test.com",
      role: "user",
      displayName: "User",
    };

    assert.throws(() => assertAdmin(user), /Admin role is required/);
  });

  it("throws for null", () => {
    assert.throws(() => assertAdmin(null), /Admin role is required/);
  });

  it("throws for undefined", () => {
    assert.throws(() => assertAdmin(undefined), /Admin role is required/);
  });

  it("throws for premium user", () => {
    const premium: AuthUser = {
      id: "p-1",
      email: "premium@test.com",
      role: "premium",
      displayName: "Premium",
    };

    assert.throws(() => assertAdmin(premium), /Admin role is required/);
  });
});

describe("auth types: canManageRoles", () => {
  it("returns true for admin", () => {
    const admin: AuthUser = {
      id: "a-1",
      email: "admin@test.com",
      role: "admin",
      displayName: "Admin",
    };

    assert.equal(canManageRoles(admin), true);
  });

  it("returns false for regular user", () => {
    const user: AuthUser = {
      id: "u-1",
      email: "user@test.com",
      role: "user",
      displayName: "User",
    };

    assert.equal(canManageRoles(user), false);
  });

  it("returns false for premium user", () => {
    const premium: AuthUser = {
      id: "p-1",
      email: "premium@test.com",
      role: "premium",
      displayName: "Premium",
    };

    assert.equal(canManageRoles(premium), false);
  });

  it("returns false for null", () => {
    assert.equal(canManageRoles(null), false);
  });

  it("returns false for undefined", () => {
    assert.equal(canManageRoles(undefined), false);
  });
});

describe("auth: password validation", () => {
  it("rejects passwords shorter than 12 characters", async () => {
    const { validatePassword } = await import("../../src/server/auth/password.ts");
    assert.throws(() => validatePassword("short"), /at least 12 characters/);
    assert.throws(() => validatePassword("12345678901"), /at least 12 characters/);
  });

  it("accepts 12-character passwords", async () => {
    const { validatePassword } = await import("../../src/server/auth/password.ts");
    // Should not throw
    validatePassword("123456789012");
  });

  it("accepts long passwords", async () => {
    const { validatePassword } = await import("../../src/server/auth/password.ts");
    validatePassword("a".repeat(100));
  });
});

describe("auth: password hashing round-trip", () => {
  it("hashes and verifies a password correctly", async () => {
    const { hashPassword, verifyPassword } = await import("../../src/server/auth/password.ts");
    const password = "test-password-12345";
    const hash = await hashPassword(password);

    assert.ok(hash.startsWith("scrypt$"), "Hash should start with format prefix");
    const parts = hash.split("$");
    assert.equal(parts.length, 3, "Hash should have format$salt$key");

    assert.ok(await verifyPassword(password, hash), "Should verify correct password");
  });

  it("rejects wrong password", async () => {
    const { hashPassword, verifyPassword } = await import("../../src/server/auth/password.ts");
    const hash = await hashPassword("correct-password-123");

    assert.ok(!(await verifyPassword("wrong-password-456", hash)), "Should reject wrong password");
  });

  it("rejects malformed hash", async () => {
    const { verifyPassword } = await import("../../src/server/auth/password.ts");

    assert.ok(!(await verifyPassword("any-password", "not-a-hash")), "Should reject malformed hash");
    assert.ok(!(await verifyPassword("any-password", "bcrypt$abc$def")), "Should reject wrong format");
  });
});

describe("auth: session token", () => {
  it("creates and hashes session tokens", async () => {
    const { createSessionToken, hashSessionToken } = await import("../../src/server/auth/session-token.ts");

    const token = createSessionToken();
    assert.ok(typeof token === "string", "Token should be a string");
    assert.ok(token.length > 20, "Token should be reasonably long");

    const hash1 = hashSessionToken(token);
    const hash2 = hashSessionToken(token);
    assert.equal(hash1, hash2, "Same token should produce same hash");
  });

  it("different tokens produce different hashes", async () => {
    const { createSessionToken, hashSessionToken } = await import("../../src/server/auth/session-token.ts");

    const token1 = createSessionToken();
    const token2 = createSessionToken();

    assert.notEqual(
      hashSessionToken(token1),
      hashSessionToken(token2),
      "Different tokens should produce different hashes",
    );
  });

  it("session expiry is 30 days from now", async () => {
    const { sessionExpiresAt, SESSION_TTL_DAYS } = await import("../../src/server/auth/session-token.ts");

    const now = new Date("2026-01-15T12:00:00Z");
    const expires = sessionExpiresAt(now);

    assert.equal(SESSION_TTL_DAYS, 30);
    assert.ok(expires.getTime() > now.getTime(), "Expiry should be in the future");
    const diffDays = (expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    assert.ok(Math.abs(diffDays - 30) < 0.01, "Should be approximately 30 days");
  });
});
