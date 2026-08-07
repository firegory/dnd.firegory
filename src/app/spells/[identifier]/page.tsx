import { notFound } from "next/navigation";

import { AppLayout } from "../../../components/ui/app-layout";
import { requireUser } from "../../../server/auth/session";
import { retrievalUser } from "../../../server/compendium/http";
import { SpellNotFoundError, SpellReadService } from "../../../server/compendium/spell-read-service";
import { SpellDetail } from "./spell-detail";

export default async function SpellDetailPage({ params }: Readonly<{ params: Promise<{ identifier: string }> }>) {
  const user = await requireUser();
  let spell;
  try {
    const { identifier } = await params;
    spell = await new SpellReadService().get(retrievalUser(user), identifier);
  } catch (error) {
    if (error instanceof SpellNotFoundError) notFound();
    throw error;
  }
  return <AppLayout userRole={user.role}><SpellDetail spell={spell} /></AppLayout>;
}
