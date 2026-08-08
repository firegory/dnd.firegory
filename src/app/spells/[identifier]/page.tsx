import { notFound } from "next/navigation";

import { AppLayout } from "../../../components/ui/app-layout";
import { requireUser } from "../../../server/auth/session";
import { parseSelection, retrievalUser } from "../../../server/compendium/http";
import { SpellNotFoundError, SpellReadService } from "../../../server/compendium/spell-read-service";
import { SpellDetail } from "./spell-detail";

export default async function SpellDetailPage({ params, searchParams }: Readonly<{ params: Promise<{ identifier: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const user = await requireUser();
  let spell;
  try {
    const { identifier } = await params;
    const url = new URL("/spells", "http://local");
    for (const [key, value] of Object.entries(await searchParams)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, item);
    spell = await new SpellReadService().get(retrievalUser(user), identifier, parseSelection(url));
  } catch (error) {
    if (error instanceof SpellNotFoundError) notFound();
    throw error;
  }
  return <AppLayout userRole={user.role}><SpellDetail spell={spell} /></AppLayout>;
}
