import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INGESTION_QUEUE_KEY,
  type QueueMessage,
} from "../../src/server/ingestion/queue.ts";

describe("ingestion/queue", () => {
  describe("constants", () => {
    it("has the expected queue key", () => {
      assert.equal(INGESTION_QUEUE_KEY, "dnd_firegory:ingestion_queue");
    });
  });

  describe("QueueMessage type", () => {
    it("has jobId field", () => {
      const msg: QueueMessage = { jobId: "test-123" };
      assert.equal(msg.jobId, "test-123");
    });
  });
});
