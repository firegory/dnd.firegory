/**
 * Tests for the embedding provider module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getEmbeddingConfig } from "../../src/server/embeddings/provider.ts";

describe("getEmbeddingConfig", () => {
  it("should return default config when no env vars set", () => {
    const config = getEmbeddingConfig();
    assert.equal(config.model, "z-embedding");
    assert.equal(config.dimensions, 1024);
    assert.equal(config.baseUrl, "https://api.z.ai/v1");
  });

  it("should use ZAI_API_KEY from environment", () => {
    const original = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = "test-key-123";
    try {
      const config = getEmbeddingConfig();
      assert.equal(config.apiKey, "test-key-123");
    } finally {
      if (original) {
        process.env.ZAI_API_KEY = original;
      } else {
        delete process.env.ZAI_API_KEY;
      }
    }
  });

  it("should use custom base URL from environment", () => {
    const original = process.env.ZAI_EMBEDDING_BASE_URL;
    process.env.ZAI_EMBEDDING_BASE_URL = "https://custom.api.example.com/v1";
    try {
      const config = getEmbeddingConfig();
      assert.equal(config.baseUrl, "https://custom.api.example.com/v1");
    } finally {
      if (original) {
        process.env.ZAI_EMBEDDING_BASE_URL = original;
      } else {
        delete process.env.ZAI_EMBEDDING_BASE_URL;
      }
    }
  });

  it("should use custom model from environment", () => {
    const original = process.env.ZAI_EMBEDDING_MODEL;
    process.env.ZAI_EMBEDDING_MODEL = "custom-embed-v2";
    try {
      const config = getEmbeddingConfig();
      assert.equal(config.model, "custom-embed-v2");
    } finally {
      if (original) {
        process.env.ZAI_EMBEDDING_MODEL = original;
      } else {
        delete process.env.ZAI_EMBEDDING_MODEL;
      }
    }
  });

  it("should use custom dimensions from environment", () => {
    const original = process.env.ZAI_EMBEDDING_DIMENSIONS;
    process.env.ZAI_EMBEDDING_DIMENSIONS = "512";
    try {
      const config = getEmbeddingConfig();
      assert.equal(config.dimensions, 512);
    } finally {
      if (original) {
        process.env.ZAI_EMBEDDING_DIMENSIONS = original;
      } else {
        delete process.env.ZAI_EMBEDDING_DIMENSIONS;
      }
    }
  });
});
