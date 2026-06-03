"use server";

import { requireUser } from "../../server/auth/session";
import { generateLinkToken, unlinkTelegram } from "../../server/telegram/link";

export async function generateLinkTokenAction(): Promise<string> {
  const user = await requireUser();
  return generateLinkToken(user.id);
}

export async function unlinkTelegramAction(): Promise<void> {
  const user = await requireUser();
  await unlinkTelegram(user.id);
}
