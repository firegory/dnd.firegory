import { requireUser } from "../../server/auth/session";
import { findTelegramLinkByUserId } from "../../server/telegram/link";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await requireUser();
  const link = await findTelegramLinkByUserId(user.id);

  return <SettingsClient isLinked={!!link} />;
}
