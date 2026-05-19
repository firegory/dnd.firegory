/**
 * Tests for z.ai LLM client configuration and types.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getLlmConfig } from "../../src/server/llm/zai.ts";

describe("getLlmConfig", () => {
  it("returns default config when no env vars set", () => {
    const config = getLlmConfig();
    assert.equal(config.model, process.env.ZAI_LLM_MODEL ?? "z-llm");
    assert.equal(config.maxTokens, parseInt(process.env.ZAI_LLM_MAX_TOKENS ?? "1024", 10));
    assert.equal(config.temperature, parseFloat(process.env.ZAI_LLM_TEMPERATURE ?? "0.2"));
    assert.ok(config.baseUrl.length > 0);
  });

  it("apiKey defaults to empty when ZAI_API_KEY not set", () => {
    // If ZAI_API_KEY is set in env, this tests that it's used
    const config = getLlmConfig();
    assert.equal(config.apiKey, process.env.ZAI_API_KEY ?? "");
  });

  it("uses ZAI_LLM_BASE_URL when set", () => {
    const original = process.env.ZAI_LLM_BASE_URL;
    try {
      process.env.ZAI_LLM_BASE_URL = "https://custom.api/v1";
      const config = getLlmConfig();
      assert.equal(config.baseUrl, "https://custom.api/v1");
    } finally {
      if (original === undefined) {
        delete process.env.ZAI_LLM_BASE_URL;
      } else {
        process.env.ZAI_LLM_BASE_URL = original;
      }
    }
  });

  it("uses ZAI_LLM_MODEL when set", () => {
    const original = process.env.ZAI_LLM_MODEL;
    try {
      process.env.ZAI_LLM_MODEL = "custom-model";
      const config = getLlmConfig();
      assert.equal(config.model, "custom-model");
    } finally {
      if (original === undefined) {
        delete process.env.ZAI_LLM_MODEL;
      } else {
        process.env.ZAI_LLM_MODEL = original;
      }
    }
  });
});
