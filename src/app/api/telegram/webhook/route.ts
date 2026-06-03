import { timingSafeEqual } from "node:crypto";
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
import { isUserRole } from "../../../../server/auth/types";
import type { UserRole } from "../../../../server/auth/types";
import type { AnswerLanguage } from "../../../../server/rag/format";

const SECRET_TOKEN = () => process.env.TELEGRAM_SECRET_TOKEN ?? "";

function safeSecretEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

const processedUpdates = new Map<number, number>();
const PROCESSED_TTL_MS = 300_000;
const MAX_PROCESSED = 10_000;

function isDuplicate(updateId: number): boolean {
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.set(updateId, Date.now());
  if (processedUpdates.size > MAX_PROCESSED) {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    for (const [id, ts] of processedUpdates) {
      if (ts < cutoff) processedUpdates.delete(id);
    }
  }
  return false;
}

const searchRateLimiter = new Map<number, number>();
const SEARCH_RATE_MS = 5000;
const MAX_SEARCH_ENTRIES = 10_000;

function checkSearchRate(telegramId: number): boolean {
  const now = Date.now();
  const last = searchRateLimiter.get(telegramId) ?? 0;
  if (now - last < SEARCH_RATE_MS) return false;
  searchRateLimiter.set(telegramId, now);
  if (searchRateLimiter.size > MAX_SEARCH_ENTRIES) {
    const cutoff = now - SEARCH_RATE_MS;
    for (const [id, ts] of searchRateLimiter) {
      if (ts < cutoff) searchRateLimiter.delete(id);
    }
  }
  return true;
}

const linkRateLimiter = new Map<number, { last: number; fails: number }>();
const LINK_RATE_MS = 5000;
const LINK_MAX_FAILS = 5;
const LINK_LOCKOUT_MS = 300_000;
const MAX_LINK_ENTRIES = 10_000;

function checkLinkRate(telegramId: number): { allowed: boolean; reason?: string } {
  const now = Date.now();
  const entry = linkRateLimiter.get(telegramId);

  if (entry) {
    if (entry.fails >= LINK_MAX_FAILS && now - entry.last < LINK_LOCKOUT_MS) {
      return { allowed: false, reason: "Too many failed attempts. Please try again later." };
    }
    if (now - entry.last < LINK_RATE_MS) {
      return { allowed: false, reason: "Please wait a moment before trying again." };
    }
  }

  if (linkRateLimiter.size > MAX_LINK_ENTRIES) {
    const cutoff = now - LINK_LOCKOUT_MS;
    for (const [id, e] of linkRateLimiter) {
      if (e.last < cutoff) linkRateLimiter.delete(id);
    }
  }

  return { allowed: true };
}

function recordLinkResult(telegramId: number, success: boolean): void {
  const now = Date.now();
  const entry = linkRateLimiter.get(telegramId) ?? { last: 0, fails: 0 };
  entry.last = now;
  if (success) {
    entry.fails = 0;
  } else {
    entry.fails++;
  }
  linkRateLimiter.set(telegramId, entry);
}

function telegramLanguageToAnswer(lang: string | undefined): AnswerLanguage {
  if (lang?.startsWith("ru")) return "ru";
  return "en";
}

function validateRole(role: string): UserRole {
  if (isUserRole(role)) return role;
  return "user";
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || !safeSecretEqual(secret, SECRET_TOKEN())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (isDuplicate(update.update_id)) {
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text || !message.from) {
    return NextResponse.json({ ok: true });
  }

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const text = message.text.trim();

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
    return NextResponse.json({ ok: true });
  }

  if (text.startsWith("/link ")) {
    handleLinkAsync(chatId, telegramId, text);
    return NextResponse.json({ ok: true });
  }

  if (text === "/unlink") {
    handleUnlinkAsync(chatId, telegramId);
    return NextResponse.json({ ok: true });
  }

  handleSearchAsync(chatId, telegramId, text, message.from.language_code);
  return NextResponse.json({ ok: true });
}

function handleLinkAsync(chatId: number, telegramId: number, text: string): void {
  const code = text.slice(6).trim();
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    sendMessage(chatId, "Usage: /link 123456\n\nGet a code at dnd.firegory.site/settings").catch(() => {});
    return;
  }

  const rate = checkLinkRate(telegramId);
  if (!rate.allowed) {
    sendMessage(chatId, rate.reason ?? "Please try again later.").catch(() => {});
    return;
  }

  verifyLinkCode(code, telegramId)
    .then((result) => {
      if (result.ok) {
        recordLinkResult(telegramId, true);
        sendMessage(chatId, "Account linked! You can now search by sending any message.").catch(() => {});
      } else {
        recordLinkResult(telegramId, false);
        sendMessage(chatId, result.error).catch(() => {});
      }
    })
    .catch((error) => {
      console.error("[telegram] link error:", error);
      sendMessage(chatId, "Something went wrong. Please try again later.").catch(() => {});
    });
}

function handleUnlinkAsync(chatId: number, telegramId: number): void {
  findUserByTelegramId(telegramId)
    .then(async (user) => {
      if (!user) {
        await sendMessage(chatId, "Your account is not linked. Use /link &lt;code&gt; first.");
        return;
      }
      await unlinkTelegram(user.userId);
      await sendMessage(chatId, "Account unlinked. Use /link &lt;code&gt; to link again.");
    })
    .catch((error) => {
      console.error("[telegram] unlink error:", error);
      sendMessage(chatId, "Something went wrong. Please try again later.").catch(() => {});
    });
}

function handleSearchAsync(chatId: number, telegramId: number, query: string, languageCode?: string): void {
  if (query.startsWith("/")) {
    sendMessage(chatId, "Unknown command. Send a search query or use /start for help.").catch(() => {});
    return;
  }

  if (!checkSearchRate(telegramId)) {
    sendMessage(chatId, "Please wait a moment before searching again.").catch(() => {});
    return;
  }

  sendMessage(chatId, "Searching…").catch(() => {});

  findUserByTelegramId(telegramId)
    .then(async (user) => {
      if (!user) {
        await sendMessage(
          chatId,
          "Please link your account first.\n\n" +
            "1. Go to dnd.firegory.site/settings\n" +
            '2. Click "Link Telegram"\n' +
            "3. Send the code here with /link &lt;code&gt;",
        );
        return;
      }

      const role = validateRole(user.role);
      const answerLanguage = telegramLanguageToAnswer(languageCode);

      const result = await generateAnswer({
        query,
        user: { role, userId: user.userId },
        answerLanguage,
      });

      const messages = formatAnswer(result.answer.answer, result.answer.citations);
      for (const msg of messages) {
        await sendMessage(chatId, msg);
      }
    })
    .catch((error) => {
      console.error("[telegram] search error:", error);
      sendMessage(chatId, "Search failed. Please try again later.").catch(() => {});
    });
}
