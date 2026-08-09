import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { importRunStatusClass } from "../../src/components/ui/status-styles.ts";

describe("import run status presentation", () => {
  it("uses success only for completed passive states", () => {
    assert.equal(importRunStatusClass("succeeded"), "bg-status-success/15 text-status-success");
    assert.equal(importRunStatusClass("completed"), "bg-status-success/15 text-status-success");
  });

  it("maps failed, active, pending, and cancelled states consistently", () => {
    assert.equal(importRunStatusClass("failed"), "bg-danger/15 text-danger");
    assert.equal(importRunStatusClass("running"), "bg-warning/15 text-warning");
    assert.equal(importRunStatusClass("pending"), "bg-surface-light text-text-muted");
    assert.equal(importRunStatusClass("cancelled"), "bg-surface-light text-text-muted");
    assert.equal(importRunStatusClass("unknown"), "bg-surface-light text-text-muted");
  });
});
