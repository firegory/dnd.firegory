/**
 * Tests for the embedding provider module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateEmbedding, generateEmbeddings, getEmbeddingConfig } from "../../src/server/embeddings/provider.ts";

const EMBEDDING_ENV_KEYS = [
  "EMBEDDING_PROVIDER",
  "EMBEDDING_DIMENSIONS",
  "ZAI_API_KEY",
  "ZAI_EMBEDDING_BASE_URL",
  "ZAI_EMBEDDING_MODEL",
  "ZAI_EMBEDDING_DIMENSIONS",
  "OLLAMA_BASE_URL",
  "OLLAMA_EMBEDDING_MODEL",
  "OLLAMA_EMBEDDING_DIMENSIONS",
  "OLLAMA_KEEP_ALIVE",
] as const;

function withEmbeddingEnv(fn: () => void): void {
  const original = Object.fromEntries(
    EMBEDDING_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<typeof EMBEDDING_ENV_KEYS[number], string | undefined>;

  try {
    for (const key of EMBEDDING_ENV_KEYS) {
      delete process.env[key];
    }
    fn();
  } finally {
    for (const key of EMBEDDING_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("getEmbeddingConfig", () => {
  it("should return default z.ai config when no env vars set", () => {
    withEmbeddingEnv(() => {
      const config = getEmbeddingConfig();
      assert.equal(config.provider, "zai");
      assert.equal(config.model, "z-embedding");
      assert.equal(config.dimensions, 1024);
      assert.equal(config.baseUrl, "https://api.z.ai/api/paas/v4");
    });
  });

  it("should use ZAI_API_KEY from environment", () => {
    withEmbeddingEnv(() => {
      process.env.ZAI_API_KEY = "test-key-123";
      const config = getEmbeddingConfig();
      assert.equal(config.apiKey, "test-key-123");
    });
  });

  it("should use custom z.ai base URL from environment", () => {
    withEmbeddingEnv(() => {
      process.env.ZAI_EMBEDDING_BASE_URL = "https://custom.api.example.com/v1/";
      const config = getEmbeddingConfig();
      assert.equal(config.baseUrl, "https://custom.api.example.com/v1");
    });
  });

  it("should use custom z.ai model from environment", () => {
    withEmbeddingEnv(() => {
      process.env.ZAI_EMBEDDING_MODEL = "custom-embed-v2";
      const config = getEmbeddingConfig();
      assert.equal(config.model, "custom-embed-v2");
    });
  });

  it("should use custom z.ai dimensions from environment", () => {
    withEmbeddingEnv(() => {
      process.env.ZAI_EMBEDDING_DIMENSIONS = "512";
      const config = getEmbeddingConfig();
      assert.equal(config.dimensions, 512);
    });
  });

  it("should use Ollama defaults when selected", () => {
    withEmbeddingEnv(() => {
      process.env.EMBEDDING_PROVIDER = "ollama";
      const config = getEmbeddingConfig();
      assert.equal(config.provider, "ollama");
      assert.equal(config.baseUrl, "http://127.0.0.1:11434");
      assert.equal(config.model, "bge-m3");
      assert.equal(config.dimensions, 1024);
      assert.equal(config.keepAlive, "1m");
      assert.equal(config.apiKey, "");
    });
  });

  it("should use custom Ollama settings from environment", () => {
    withEmbeddingEnv(() => {
      process.env.EMBEDDING_PROVIDER = "ollama";
      process.env.OLLAMA_BASE_URL = "http://localhost:11434/";
      process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
      process.env.OLLAMA_EMBEDDING_DIMENSIONS = "768";
      process.env.OLLAMA_KEEP_ALIVE = "0";
      const config = getEmbeddingConfig();
      assert.equal(config.baseUrl, "http://localhost:11434");
      assert.equal(config.model, "nomic-embed-text");
      assert.equal(config.dimensions, 768);
      assert.equal(config.keepAlive, "0");
    });
  });

  it("should reject unsupported providers", () => {
    withEmbeddingEnv(() => {
      process.env.EMBEDDING_PROVIDER = "unknown";
      assert.throws(() => getEmbeddingConfig(), /Unsupported EMBEDDING_PROVIDER/);
    });
  });
});

describe("generateEmbedding", () => {
  it("should call Ollama /api/embed with keep_alive and validate dimensions", async () => {
    const originalFetch = globalThis.fetch;
    const embedding = Array.from({ length: 3 }, (_, i) => i / 10);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "http://127.0.0.1:11434/api/embed");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "test-model",
        input: "hello",
        keep_alive: "0",
      });
      return new Response(JSON.stringify({ embeddings: [embedding], model: "test-model" }));
    }) as typeof fetch;

    try {
      const result = await generateEmbedding("hello", {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "test-model",
        dimensions: 3,
        keepAlive: "0",
      });
      assert.deepEqual(result.embedding, embedding);
      assert.equal(result.model, "test-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should reject embeddings with unexpected dimensions", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[1, 2]] }))) as typeof fetch;

    try {
      await assert.rejects(
        () => generateEmbedding("hello", {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "test-model",
          dimensions: 3,
          keepAlive: "1m",
        }),
        /Embedding dimension mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("generateEmbeddings", () => {
  it("should send Ollama batches as array input", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "test-model",
        input: ["one", "two"],
        keep_alive: "1m",
      });
      return new Response(JSON.stringify({ embeddings: [[1], [2]], model: "test-model" }));
    }) as typeof fetch;

    try {
      const results = await generateEmbeddings(["one", "two"], {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "test-model",
        dimensions: 1,
        keepAlive: "1m",
      });
      assert.deepEqual(results.map((result) => result.embedding), [[1], [2]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
