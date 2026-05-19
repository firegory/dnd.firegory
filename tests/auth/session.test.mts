import assert from "node:assert/strict";
import test from "node:test";

import { createSessionToken, hashSessionToken, sessionExpiresAt } from "../../src/server/auth/session-token.ts";
import { assertAdmin, canManageRoles } from "../../src/server/auth/types.ts";

test("session tokens are random and stored as stable hashes", () => {
  const first = createSessionToken();
  const second = createSessionToken();

  assert.notEqual(first, second);
  assert.notEqual(hashSessionToken(first), first);
  assert.equal(hashSessionToken(first), hashSessionToken(first));
});

test("session expiration is about thirty days in the future", () => {
  const now = new Date("2026-05-19T00:00:00.000Z");
  assert.equal(sessionExpiresAt(now).toISOString(), "2026-06-18T00:00:00.000Z");
});

test("admin helpers expose a simple contract for feature work", () => {
  assert.equal(canManageRoles({ id: "1", email: "a@example.com", role: "admin", displayName: null }), true);
  assert.equal(canManageRoles({ id: "2", email: "u@example.com", role: "user", displayName: null }), false);
  assert.doesNotThrow(() => assertAdmin({ id: "1", email: "a@example.com", role: "admin", displayName: null }));
  assert.throws(() => assertAdmin({ id: "2", email: "u@example.com", role: "user", displayName: null }), /Admin role/);
});
