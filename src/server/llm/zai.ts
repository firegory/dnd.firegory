/**
 * z.ai LLM client for chat completions.
 *
 * Server-side only. The API key is never exposed to client bundles.
 * Uses the same z.ai base URL and key as the embedding provider.
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
  baseUrl: "https://api.z.ai/api/paas/v4",
  model: "z-llm",
  maxTokens: 4096,
  temperature: 0.2,
};

/**
 * Gets the LLM configuration from environment variables.
 */
export function getLlmConfig(): LlmConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    apiKey: process.env.ZAI_API_KEY ?? "",
    baseUrl: process.env.ZAI_LLM_BASE_URL ?? DEFAULT_LLM_CONFIG.baseUrl,
    model: process.env.ZAI_LLM_MODEL ?? DEFAULT_LLM_CONFIG.model,
    maxTokens: parseInt(process.env.ZAI_LLM_MAX_TOKENS ?? "1024", 10),
    temperature: parseFloat(process.env.ZAI_LLM_TEMPERATURE ?? "0.2"),
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

/**
 * Calls the z.ai chat completions endpoint.
 *
 * Throws on network or API errors. Does not leak the API key in errors.
 */
export async function chatCompletion(
  messages: readonly ChatMessage[],
  config?: Partial<LlmConfig>,
): Promise<ChatCompletionResult> {
  const cfg = { ...getLlmConfig(), ...config };

  if (!cfg.apiKey) {
    throw new Error("ZAI_API_KEY is required for answer generation");
  }

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
    }),
  });

  if (!response.ok) {
    const status = response.status;
    const statusText = response.statusText;
    // Deliberately do not include response body which may contain internal details
    throw new Error(
      `LLM API error: ${status} ${statusText}`,
    );
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
