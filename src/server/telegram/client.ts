const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

function apiUrl(method: string): string {
  return `${TELEGRAM_API_BASE}${getBotToken()}/${method}`;
}

export type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
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
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`setWebhook failed: ${JSON.stringify(result)}`);
  }

  console.log("[telegram] webhook set:", url);
}

export async function deleteWebhook(): Promise<void> {
  await fetch(apiUrl("deleteWebhook"), { method: "POST" });
}

export async function getWebhookInfo(): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl("getWebhookInfo"));
  return response.json() as Promise<Record<string, unknown>>;
}

export async function getMe(): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl("getMe"));
  return response.json() as Promise<Record<string, unknown>>;
}
