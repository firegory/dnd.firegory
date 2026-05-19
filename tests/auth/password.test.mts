import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword, validatePassword } from "../../src/server/auth/password.ts";

test("password hashes are salted and verifiable", async () => {
  const password = "correct horse battery staple";
  const firstHash = await hashPassword(password);
  const secondHash = await hashPassword(password);

  assert.notEqual(firstHash, password);
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword(password, firstHash), true);
  assert.equal(await verifyPassword("wrong password", firstHash), false);
});

test("password validation rejects short passwords", () => {
  assert.throws(() => validatePassword("short"), /at least 12/);
});
