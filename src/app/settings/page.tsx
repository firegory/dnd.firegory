import { AppLayout } from "../../components/ui/app-layout";
import { T } from "../../components/ui/i18n";
import { requireUser } from "../../server/auth/session";
import { findTelegramLinkByUserId } from "../../server/telegram/link";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await requireUser();
  const link = await findTelegramLinkByUserId(user.id);

  return (
    <AppLayout userRole={user.role}>
      <div className="space-y-8">
        <h1 className="text-2xl font-bold text-text-primary">
          <T k="settings" />
        </h1>

        <section className="rounded-xl border border-border bg-surface p-6">
          <h2 className="text-lg font-semibold text-text-primary">
            <T k="telegramSectionTitle" />
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            <T k="telegramSectionDescription" />
          </p>

          <div className="mt-6">
            <SettingsClient isLinked={!!link} />
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
