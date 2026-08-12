import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getLlmConfig, LlmConfigurationError } from "../../src/server/llm/client.ts";

const CONFIG_NAMES = [
  "LLM_API_KEY", "LLM_API_KEY_FILE", "LLM_BASE_URL", "LLM_MODEL", "LLM_MAX_TOKENS", "LLM_TEMPERATURE",
  "ZAI_API_KEY", "ZAI_API_KEY_FILE", "ZAI_LLM_BASE_URL", "ZAI_LLM_MODEL", "ZAI_LLM_MAX_TOKENS",
  "ZAI_LLM_TEMPERATURE",
] as const;

function withConfig(environment: Partial<Record<(typeof CONFIG_NAMES)[number], string>>, run: () => void): void {
  const previous = Object.fromEntries(CONFIG_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of CONFIG_NAMES) delete process.env[name];
    Object.assign(process.env, environment);
    run();
  } finally {
    for (const name of CONFIG_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("getLlmConfig", () => {
  it("uses OpenAI defaults when no provider is configured", () => withConfig({}, () => {
    assert.deepEqual(getLlmConfig(), {
      apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", maxTokens: 1024, temperature: 0.2,
    });
  }));

  it("treats blank generic values as unset and does not suppress valid ZAI configuration", () => withConfig({
    LLM_API_KEY: "  ", LLM_BASE_URL: "", LLM_MODEL: "   ",
    ZAI_API_KEY: "zai-secret", ZAI_LLM_MODEL: "glm-test",
  }, () => {
    const config = getLlmConfig();
    assert.equal(config.apiKey, "zai-secret");
    assert.equal(config.baseUrl, "https://api.z.ai/api/paas/v4");
    assert.equal(config.model, "glm-test");
  }));

  it("does not read fallback provider secrets after selecting the generic provider", () => withConfig({
    LLM_API_KEY: "generic-secret",
    ZAI_API_KEY_FILE: "/not/a/real/zai-key",
  }, () => {
    const config = getLlmConfig();
    assert.equal(config.apiKey, "generic-secret");
    assert.equal(config.baseUrl, "https://api.openai.com/v1");
  }));

  it("ignores a blank LLM secret file and reads the ZAI secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "dnd-llm-"));
    const llmFile = join(directory, "llm");
    const zaiFile = join(directory, "zai");
    writeFileSync(llmFile, "\n");
    writeFileSync(zaiFile, "zai-from-file\n");
    try {
      withConfig({ LLM_API_KEY_FILE: llmFile, ZAI_API_KEY_FILE: zaiFile }, () => {
        const config = getLlmConfig();
        assert.equal(config.apiKey, "zai-from-file");
        assert.equal(config.baseUrl, "https://api.z.ai/api/paas/v4");
        assert.equal(config.model, "glm-4.5-flash");
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports safe explicit configuration errors", () => {
    withConfig({ LLM_MAX_TOKENS: "12oops" }, () => {
      assert.throws(() => getLlmConfig(), (error) => error instanceof LlmConfigurationError
        && error.message === "LLM_MAX_TOKENS must be an integer from 1 through 8192.");
    });
    withConfig({ LLM_BASE_URL: "file:///secret" }, () => {
      assert.throws(() => getLlmConfig(), LlmConfigurationError);
    });
    withConfig({ LLM_API_KEY_FILE: "/not/a/real/key" }, () => {
      assert.throws(() => getLlmConfig(), (error) => error instanceof LlmConfigurationError
        && error.message === "LLM_API_KEY_FILE could not be read.");
    });
  });
});
