/**
 * Tests for LLM client configuration and types.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getLlmConfig } from "../../src/server/llm/client.ts";

const LLM_ENV_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_MAX_TOKENS",
  "LLM_TEMPERATURE",
] as const;

function withLlmEnv(fn: () => void): void {
  const original = Object.fromEntries(
    LLM_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<typeof LLM_ENV_KEYS[number], string | undefined>;

  try {
    for (const key of LLM_ENV_KEYS) {
      delete process.env[key];
    }
    fn();
  } finally {
    for (const key of LLM_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("getLlmConfig", () => {
  it("returns default config when no env vars set", () => {
    withLlmEnv(() => {
      const config = getLlmConfig();
      assert.equal(config.model, "gpt-4o-mini");
      assert.equal(config.maxTokens, 1024);
      assert.equal(config.temperature, 0.2);
      assert.equal(config.baseUrl, "https://api.openai.com/v1");
      assert.equal(config.apiKey, "");
    });
  });

  it("apiKey defaults to empty when LLM_API_KEY not set", () => {
    withLlmEnv(() => {
      const config = getLlmConfig();
      assert.equal(config.apiKey, "");
    });
  });

  it("uses LLM_BASE_URL when set", () => {
    withLlmEnv(() => {
      process.env.LLM_BASE_URL = "https://custom.api/v1";
      const config = getLlmConfig();
      assert.equal(config.baseUrl, "https://custom.api/v1");
    });
  });

  it("trims trailing slash from LLM_BASE_URL", () => {
    withLlmEnv(() => {
      process.env.LLM_BASE_URL = "https://custom.api/v1/";
      const config = getLlmConfig();
      assert.equal(config.baseUrl, "https://custom.api/v1");
    });
  });

  it("uses LLM_MODEL when set", () => {
    withLlmEnv(() => {
      process.env.LLM_MODEL = "custom-model";
      const config = getLlmConfig();
      assert.equal(config.model, "custom-model");
    });
  });

  it("uses LLM_MAX_TOKENS when set", () => {
    withLlmEnv(() => {
      process.env.LLM_MAX_TOKENS = "2048";
      const config = getLlmConfig();
      assert.equal(config.maxTokens, 2048);
    });
  });

  it("uses LLM_TEMPERATURE when set", () => {
    withLlmEnv(() => {
      process.env.LLM_TEMPERATURE = "0.5";
      const config = getLlmConfig();
      assert.equal(config.temperature, 0.5);
    });
  });

  it("rejects invalid LLM_MAX_TOKENS", () => {
    withLlmEnv(() => {
      process.env.LLM_MAX_TOKENS = "not-a-number";
      assert.throws(() => getLlmConfig(), /Invalid LLM_MAX_TOKENS/);
    });
  });

  it("rejects invalid LLM_TEMPERATURE", () => {
    withLlmEnv(() => {
      process.env.LLM_TEMPERATURE = "bad";
      assert.throws(() => getLlmConfig(), /Invalid LLM_TEMPERATURE/);
    });
  });
});
