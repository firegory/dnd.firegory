const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const FETCH_TIMEOUT_MS = 10_000;

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

function apiUrl(method: string): string {
  return `${TELEGRAM_API_BASE}${getBotToken()}/${method}`;
}

function abortTimeout(ms: number = FETCH_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

export type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string; language_code?: string };
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export async function sendMessage(
  chatId: number,
  text: string,
  options?: { parse_mode?: "HTML" | "Markdown" },
): Promise<void> {
  const response = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: options?.parse_mode ?? "HTML",
    }),
    signal: abortTimeout(),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("[telegram] sendMessage failed:", response.status, body);
  }
}

export async function setWebhook(
  url: string,
  secretToken: string,
): Promise<void> {
  const response = await fetch(apiUrl("setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
    }),
    signal: abortTimeout(),
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`setWebhook failed: ${JSON.stringify(result)}`);
  }

  console.log("[telegram] webhook set:", url);
}
