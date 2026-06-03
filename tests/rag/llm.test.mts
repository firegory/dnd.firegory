import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getLlmConfig } from "../../src/server/llm/client.ts";

describe("getLlmConfig", () => {
  it("returns default config when no env vars set", () => {
    const config = getLlmConfig();
    assert.equal(config.model, process.env.LLM_MODEL ?? "gpt-4o-mini");
    assert.equal(config.maxTokens, parseInt(process.env.LLM_MAX_TOKENS ?? "1024", 10));
    assert.equal(config.temperature, parseFloat(process.env.LLM_TEMPERATURE ?? "0.2"));
    assert.ok(config.baseUrl.length > 0);
  });

  it("apiKey defaults to empty when LLM_API_KEY not set", () => {
    const config = getLlmConfig();
    assert.equal(config.apiKey, process.env.LLM_API_KEY ?? "");
  });

  it("uses LLM_BASE_URL when set", () => {
    const original = process.env.LLM_BASE_URL;
    try {
      process.env.LLM_BASE_URL = "https://custom.api/v1";
      const config = getLlmConfig();
      assert.equal(config.baseUrl, "https://custom.api/v1");
    } finally {
      if (original === undefined) {
        delete process.env.LLM_BASE_URL;
      } else {
        process.env.LLM_BASE_URL = original;
      }
    }
  });

  it("uses LLM_MODEL when set", () => {
    const original = process.env.LLM_MODEL;
    try {
      process.env.LLM_MODEL = "custom-model";
      const config = getLlmConfig();
      assert.equal(config.model, "custom-model");
    } finally {
      if (original === undefined) {
        delete process.env.LLM_MODEL;
      } else {
        process.env.LLM_MODEL = original;
      }
    }
  });
});
