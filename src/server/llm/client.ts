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

/**
 * Gets the LLM configuration from environment variables.
 */
export function getLlmConfig(): LlmConfig {
  const baseUrl = (
    process.env.LLM_BASE_URL ?? process.env.ZAI_LLM_BASE_URL ?? DEFAULT_LLM_CONFIG.baseUrl
  ).replace(/\/+$/, "");
  const maxTokensStr = process.env.LLM_MAX_TOKENS ?? process.env.ZAI_LLM_MAX_TOKENS ?? String(DEFAULT_LLM_CONFIG.maxTokens);
  const maxTokens = parseInt(maxTokensStr, 10);
  const temperatureStr = process.env.LLM_TEMPERATURE ?? process.env.ZAI_LLM_TEMPERATURE ?? "0.2";
  const temperature = parseFloat(temperatureStr);
  if (!Number.isFinite(maxTokens)) {
    throw new Error(`Invalid LLM_MAX_TOKENS: ${maxTokensStr}`);
  }
  if (!Number.isFinite(temperature)) {
    throw new Error(`Invalid LLM_TEMPERATURE: ${temperatureStr}`);
  }
  return {
    ...DEFAULT_LLM_CONFIG,
    apiKey: process.env.LLM_API_KEY ?? process.env.ZAI_API_KEY ?? "",
    baseUrl,
    model: process.env.LLM_MODEL ?? process.env.ZAI_LLM_MODEL ?? DEFAULT_LLM_CONFIG.model,
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

function isTgiEndpoint(baseUrl: string): boolean {
  if (process.env.LLM_PROVIDER === "tgi") return true;
  if (process.env.LLM_PROVIDER && process.env.LLM_PROVIDER !== "tgi") return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes("huggingface") ||
      url.hostname.includes("hf.co");
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

  if (isTgiEndpoint(cfg.baseUrl)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
  config?: Partial<LlmConfig> & { preferOllamaNative?: boolean; responseFormat?: "json" },
): Promise<ChatCompletionResult> {
  const { preferOllamaNative, responseFormat, ...rest } = config ?? {};
  const cfg = { ...getLlmConfig(), ...rest };

  if (isOllama(cfg.baseUrl, cfg.apiKey)) {
    if (preferOllamaNative || responseFormat === "json") {
      return ollamaChatCompletion(messages, cfg, responseFormat);
    }
    return openAiChatCompletion(messages, cfg);
  }

  if (!cfg.apiKey && !isPrivateUrl(cfg.baseUrl)) {
    throw new Error("LLM_API_KEY is not configured");
  }

  return openAiChatCompletion(messages, cfg);
}
