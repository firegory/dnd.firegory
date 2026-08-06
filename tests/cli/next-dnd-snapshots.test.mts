import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = "scripts/collect-next-dnd-snapshots.mts";

test("next.dnd.su snapshot CLI documents explicit network consent", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--allow-network/);
  assert.match(result.stdout, /does not publish content/i);
});

test("next.dnd.su snapshot CLI refuses implicit live collection", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--output", "/tmp/unused-next-dnd-test"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pass --allow-network explicitly/);
});
