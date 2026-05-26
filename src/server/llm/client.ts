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
  return {
    ...DEFAULT_LLM_CONFIG,
    apiKey: process.env.LLM_API_KEY ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? DEFAULT_LLM_CONFIG.baseUrl,
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_CONFIG.model,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? String(DEFAULT_LLM_CONFIG.maxTokens), 10),
    temperature: parseFloat(process.env.LLM_TEMPERATURE ?? "0.2"),
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
): Promise<ChatCompletionResult> {
  const url = new URL(cfg.baseUrl);
  const nativeUrl = `${url.origin}/api/chat`;

  const response = await fetch(nativeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      think: false,
      keep_alive: "30m",
      options: {
        num_predict: cfg.maxTokens,
        temperature: cfg.temperature,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const lines = await response.text();
  const lastLine = lines.trim().split("\n").pop();
  if (!lastLine) throw new Error("LLM API returned empty response");

  const data = JSON.parse(lastLine) as {
    message?: { content?: string };
    model?: string;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const content = data.message?.content;
  if (!content) throw new Error("LLM API returned no content");

  return {
    content,
    finishReason: data.done_reason ?? null,
    model: data.model ?? cfg.model,
    usage: {
      promptTokens: data.prompt_eval_count ?? null,
      completionTokens: data.eval_count ?? null,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0) || null,
    },
  };
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

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
    }),
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
  config?: Partial<LlmConfig>,
): Promise<ChatCompletionResult> {
  const cfg = { ...getLlmConfig(), ...config };

  if (isOllama(cfg.baseUrl, cfg.apiKey)) {
    return ollamaChatCompletion(messages, cfg);
  }

  return openAiChatCompletion(messages, cfg);
}
