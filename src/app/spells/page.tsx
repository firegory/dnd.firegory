import { AppLayout } from "../../components/ui/app-layout";
import { requireUser } from "../../server/auth/session";
import { retrievalUser } from "../../server/compendium/http";
import { parseSpellListOptions } from "../../server/compendium/spell-http";
import { SpellReadService } from "../../server/compendium/spell-read-service";
import { SpellList } from "./spell-list";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SpellsPage({ searchParams }: Readonly<{ searchParams: SearchParams }>) {
  const user = await requireUser();
  const params = await searchParams;
  const url = new URL("http://local/spells");
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, item);
  }
  const options = parseSpellListOptions(url);
  const result = await new SpellReadService().list(retrievalUser(user), options);
  if (result.nextCursor) url.searchParams.set("cursor", result.nextCursor);
  return (
    <AppLayout userRole={user.role}>
      <SpellList spells={result.spells} count={result.count} options={options} nextHref={result.nextCursor ? `/spells?${url.searchParams}` : null} />
    </AppLayout>
  );
}
