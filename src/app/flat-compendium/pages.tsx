import { AppLayout } from "../../components/ui/app-layout";
import { requireUser } from "../../server/auth/session";
import { retrievalUser } from "../../server/compendium/http";
import { flatCollection, flatSelection, parseFlatListOptions } from "../../server/compendium/flat-http";
import { FlatReadService } from "../../server/compendium/flat-read-service";
import type { FlatEntryType } from "../../server/compendium/flat-schema";
import { FlatDetail } from "./flat-detail";
import { FlatList } from "./flat-list";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export async function FlatListPage({ type, searchParams }: Readonly<{ type: FlatEntryType; searchParams: SearchParams }>) {
  const user = await requireUser(); const params = await searchParams; const collection = flatCollection(type); const url = new URL(`http://local/${collection}`);
  for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, item);
  const options = parseFlatListOptions(url); const result = await new FlatReadService().list(retrievalUser(user), type, options);
  if (result.nextCursor) url.searchParams.set("cursor", result.nextCursor);
  return <AppLayout userRole={user.role}><FlatList type={type} entries={result.entries} count={result.count} options={options} nextHref={result.nextCursor ? `/${collection}?${url.searchParams}` : null} /></AppLayout>;
}
export async function FlatDetailPage({ type, identifier }: Readonly<{ type: FlatEntryType; identifier: string }>) {
  const user = await requireUser(); const entry = await new FlatReadService().get(retrievalUser(user), type, identifier, flatSelection({}));
  return <AppLayout userRole={user.role}><FlatDetail entry={entry} /></AppLayout>;
}
