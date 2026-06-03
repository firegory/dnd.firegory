import { requireUser } from "../../server/auth/session";
import {
  findTelegramLinkByUserId,
  generateLinkToken,
  unlinkTelegram,
} from "../../server/telegram/link";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await requireUser();
  const link = await findTelegramLinkByUserId(user.id);

  return <SettingsClient userId={user.id} isLinked={!!link} />;
}

export async function generateLinkTokenAction(): Promise<string> {
  "use server";
  const user = await requireUser();
  return generateLinkToken(user.id);
}

export async function unlinkTelegramAction(): Promise<void> {
  "use server";
  const user = await requireUser();
  await unlinkTelegram(user.id);
}
