import { NextResponse } from "next/server";

import type { TelegramUpdate } from "../../../../server/telegram/client";
import { sendMessage } from "../../../../server/telegram/client";
import {
  verifyLinkCode,
  unlinkTelegram,
  findUserByTelegramId,
} from "../../../../server/telegram/link";
import { generateAnswer } from "../../../../server/rag/answer";
import { formatAnswer } from "../../../../server/telegram/format";

const SECRET_TOKEN = () => process.env.TELEGRAM_SECRET_TOKEN ?? "";

const rateLimiter = new Map<number, number>();
const RATE_LIMIT_MS = 5000;

export async function POST(request: Request): Promise<NextResponse> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== SECRET_TOKEN()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = update.message;
  if (!message?.text || !message.from) {
    return NextResponse.json({ ok: true });
  }

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const text = message.text.trim();

  try {
    if (text === "/start" || text === "/help") {
      await sendMessage(
        chatId,
        "<b>D&D Knowledge Base Bot</b>\n\n" +
          "Send any message to search the D&D rules database and get a citation-backed answer.\n\n" +
          "<b>Commands:</b>\n" +
          "/link &lt;code&gt; — Link your website account\n" +
          "/unlink — Unlink your account\n" +
          "/start — Show this message",
      );
    } else if (text.startsWith("/link ")) {
      await handleLink(chatId, telegramId, text);
    } else if (text === "/unlink") {
      await handleUnlink(chatId, telegramId);
    } else {
      await handleSearch(chatId, telegramId, text);
    }
  } catch (error) {
    console.error("[telegram] handler error:", error);
    await sendMessage(chatId, "Something went wrong. Please try again later.").catch(
      () => {},
    );
  }

  return NextResponse.json({ ok: true });
}

async function handleLink(
  chatId: number,
  telegramId: number,
  text: string,
): Promise<void> {
  const code = text.slice(6).trim();
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    await sendMessage(chatId, "Usage: /link 123456\n\nGet a code at dnd.firegory.site/settings");
    return;
  }

  const result = await verifyLinkCode(code, telegramId);
  if (result.ok) {
    await sendMessage(chatId, "✅ Account linked! You can now search by sending any message.");
  } else {
    await sendMessage(chatId, `❌ ${result.error}`);
  }
}

async function handleUnlink(
  chatId: number,
  telegramId: number,
): Promise<void> {
  const user = await findUserByTelegramId(telegramId);
  if (!user) {
    await sendMessage(chatId, "Your account is not linked. Use /link &lt;code&gt; first.");
    return;
  }

  await unlinkTelegram(user.userId);
  await sendMessage(chatId, "✅ Account unlinked. Use /link &lt;code&gt; to link again.");
}

async function handleSearch(
  chatId: number,
  telegramId: number,
  query: string,
): Promise<void> {
  if (query.startsWith("/")) {
    await sendMessage(chatId, "Unknown command. Send a search query or use /start for help.");
    return;
  }

  const user = await findUserByTelegramId(telegramId);
  if (!user) {
    await sendMessage(
      chatId,
      "Please link your account first.\n\n" +
        "1. Go to dnd.firegory.site/settings\n" +
        "2. Click \"Link Telegram\"\n" +
        "3. Send the code here with /link &lt;code&gt;",
    );
    return;
  }

  const now = Date.now();
  const lastQuery = rateLimiter.get(telegramId) ?? 0;
  if (now - lastQuery < RATE_LIMIT_MS) {
    await sendMessage(chatId, "Please wait a moment before searching again.");
    return;
  }
  rateLimiter.set(telegramId, now);

  await sendMessage(chatId, "🔍 Searching…");

  try {
    const result = await generateAnswer({
      query,
      user: { role: user.role as "user" | "premium" | "admin", userId: user.userId },
      answerLanguage: "en",
    });

    const messages = formatAnswer(result.answer.answer, result.answer.citations);
    for (const msg of messages) {
      await sendMessage(chatId, msg);
    }
  } catch (error) {
    console.error("[telegram] search error:", error);
    await sendMessage(chatId, "Search failed. Please try again later.");
  }
}
