/**
 * LLM client for chat completions.
 *
 * Server-side only. The API key is never exposed to client bundles.
 *
 * Detects Ollama (no API key + Ollama-like URL) and uses the native
 * /api/chat endpoint with think:false to avoid hidden reasoning tokens
 * that waste generation budget and slow down responses.
 * Otherwise uses the standard OpenAI-compatible /chat/completions endpoint.
 */

import { readFileSync } from "node:fs";

export type LlmConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}>;

const DEFAULT_LLM_CONFIG: LlmConfig = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  maxTokens: 1024,
  temperature: 0.2,
};

const DEFAULT_ZAI_LLM_CONFIG: LlmConfig = {
  ...DEFAULT_LLM_CONFIG,
  baseUrl: "https://api.z.ai/api/paas/v4",
  model: "glm-4.5-flash",
};

export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigurationError";
  }
}

/**
 * Gets the LLM configuration from environment variables.
 */
export function getLlmConfig(): LlmConfig {
  const llmKey = optionalSecret("LLM_API_KEY", "LLM_API_KEY_FILE");
  const zaiKey = llmKey ? undefined : optionalSecret("ZAI_API_KEY", "ZAI_API_KEY_FILE");
  const defaults = !llmKey && zaiKey ? DEFAULT_ZAI_LLM_CONFIG : DEFAULT_LLM_CONFIG;
  const apiKey = llmKey ?? zaiKey ?? "";
  const baseUrl = (nonBlank(process.env.LLM_BASE_URL)
    ?? nonBlank(process.env.ZAI_LLM_BASE_URL)
    ?? defaults.baseUrl).replace(/\/+$/, "");
  const model = nonBlank(process.env.LLM_MODEL) ?? nonBlank(process.env.ZAI_LLM_MODEL) ?? defaults.model;
  const maxTokensStr = nonBlank(process.env.LLM_MAX_TOKENS)
    ?? nonBlank(process.env.ZAI_LLM_MAX_TOKENS)
    ?? String(defaults.maxTokens);
  const temperatureStr = nonBlank(process.env.LLM_TEMPERATURE)
    ?? nonBlank(process.env.ZAI_LLM_TEMPERATURE)
    ?? String(defaults.temperature);
  const maxTokens = Number(maxTokensStr);
  const temperature = Number(temperatureStr);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    throw new LlmConfigurationError("LLM_MAX_TOKENS must be an integer from 1 through 8192.");
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new LlmConfigurationError("LLM_TEMPERATURE must be a number from 0 through 2.");
  }
  validateBaseUrl(baseUrl);
  return {
    ...defaults,
    apiKey,
    baseUrl,
    model,
    maxTokens,
    temperature,
  };
}

export type ChatMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type ChatCompletionResult = Readonly<{
  content: string;
  finishReason: string | null;
  model: string;
  usage: Readonly<{
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

function isOllama(baseUrl: string, apiKey: string): boolean {
  if (apiKey) return false;
  try {
    const url = new URL(baseUrl);
    return url.port === "11434" || url.hostname.includes("ollama");
  } catch {
    return false;
  }
}

async function ollamaChatCompletion(
  messages: readonly ChatMessage[],
  cfg: LlmConfig,
  format?: "json",
  signal?: AbortSignal,
): Promise<ChatCompletionResult> {
  const url = new URL(cfg.baseUrl);
  const nativeUrl = `${url.origin}/api/chat`;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    think: false,
    keep_alive: "30m",
    options: {
      num_predict: cfg.maxTokens,
      temperature: cfg.temperature,
    },
  };
  if (format) body.format = format;

  const response = await fetch(nativeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const lines = await response.text();
  const lastLine = lines.trim().split("\n").pop();
  if (!lastLine) throw new Error("LLM API returned empty response");

  let data: {
    message?: { content?: string };
    model?: string;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  try {
    data = JSON.parse(lastLine);
  } catch {
    throw new Error(`LLM API returned invalid JSON: ${lastLine.slice(0, 200)}`);
  }

  const content = data.message?.content;
  if (content === undefined || content === null) throw new Error("LLM API returned no content");

  return {
    content,
    finishReason: data.done_reason ?? null,
    model: data.model ?? cfg.model,
    usage: {
      promptTokens: data.prompt_eval_count ?? null,
      completionTokens: data.eval_count ?? null,
      totalTokens: data.prompt_eval_count != null && data.eval_count != null
        ? data.prompt_eval_count + data.eval_count
        : null,
    },
  };
}

function needsThinkingDisabled(baseUrl: string): boolean {
  if (process.env.LLM_DISABLE_THINKING === "true") return true;
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes("huggingface") ||
      url.hostname.includes("hf.co") ||
      url.hostname.includes("bekendesite");
  } catch {
    return false;
  }
}

function isPrivateUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const h = url.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" ||
      h.startsWith("192.168.") || h.startsWith("10.") ||
      h.endsWith(".local") || h.endsWith(".home")) return true;
    if ((/^172\.(1[6-9]|2\d|3[01])\./).test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

async function openAiChatCompletion(
  messages: readonly ChatMessage[],
  cfg: LlmConfig,
  format?: "json",
  signal?: AbortSignal,
): Promise<ChatCompletionResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
  };
  if (format === "json") body.response_format = { type: "json_object" };

  if (needsThinkingDisabled(cfg.baseUrl)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const content = data.choices?.[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new Error("LLM API returned no content");
  }

  return {
    content,
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    model: data.model ?? cfg.model,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
    },
  };
}

/**
 * Calls the LLM chat completions endpoint.
 *
 * Automatically uses Ollama native API (with think:false) when detecting
 * an Ollama endpoint, otherwise uses OpenAI-compatible API.
 */
export async function chatCompletion(
  messages: readonly ChatMessage[],
  config?: Partial<LlmConfig> & { preferOllamaNative?: boolean; responseFormat?: "json"; signal?: AbortSignal },
): Promise<ChatCompletionResult> {
  const { preferOllamaNative, responseFormat, signal, ...rest } = config ?? {};
  const configured = getLlmConfig();
  const cfg: LlmConfig = {
    ...configured,
    ...rest,
    apiKey: nonBlank(rest.apiKey) ?? configured.apiKey,
    baseUrl: (nonBlank(rest.baseUrl) ?? configured.baseUrl).replace(/\/+$/, ""),
    model: nonBlank(rest.model) ?? configured.model,
  };
  validateBaseUrl(cfg.baseUrl);

  if (isOllama(cfg.baseUrl, cfg.apiKey)) {
    if (preferOllamaNative || responseFormat === "json") {
      return ollamaChatCompletion(messages, cfg, responseFormat, signal);
    }
    return openAiChatCompletion(messages, cfg, responseFormat, signal);
  }

  if (!cfg.apiKey && !isPrivateUrl(cfg.baseUrl)) {
    throw new LlmConfigurationError("No LLM API key is configured for the remote provider.");
  }

  return openAiChatCompletion(messages, cfg, responseFormat, signal);
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalSecret(environmentName: string, fileEnvironmentName: string): string | undefined {
  const inline = nonBlank(process.env[environmentName]);
  const file = nonBlank(process.env[fileEnvironmentName]);
  if (inline) return inline;
  if (!file) return undefined;

  try {
    return nonBlank(readFileSync(file, "utf8"));
  } catch {
    throw new LlmConfigurationError(`${fileEnvironmentName} could not be read.`);
  }
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmConfigurationError("LLM_BASE_URL must be a valid HTTP(S) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
    || url.search || url.hash) {
    throw new LlmConfigurationError("LLM_BASE_URL must be an HTTP(S) origin/path without credentials, query, or fragment.");
  }
}
