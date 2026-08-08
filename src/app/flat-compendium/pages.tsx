import { notFound } from "next/navigation";

import { AppLayout } from "../../components/ui/app-layout";
import { requireUser } from "../../server/auth/session";
import { retrievalUser } from "../../server/compendium/http";
import { flatCollection, parseFlatListOptions, parseFlatSelection } from "../../server/compendium/flat-http";
import { FlatNotFoundError, FlatReadService } from "../../server/compendium/flat-read-service";
import type { FlatEntryType } from "../../server/compendium/flat-schema";
import { FlatDetail } from "./flat-detail";
import { FlatList } from "./flat-list";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export async function FlatListPage({ type, searchParams }: Readonly<{ type: FlatEntryType; searchParams: SearchParams }>) {
  const user = await requireUser(); const collection = flatCollection(type); const url = searchParamsUrl(`/${collection}`, await searchParams);
  const options = parseFlatListOptions(url); const result = await new FlatReadService().list(retrievalUser(user), type, options);
  if (result.nextCursor) url.searchParams.set("cursor", result.nextCursor);
  return <AppLayout userRole={user.role}><FlatList type={type} entries={result.entries} count={result.count} options={options} nextHref={result.nextCursor ? `/${collection}?${url.searchParams}` : null} /></AppLayout>;
}
export async function FlatDetailPage({ type, identifier, searchParams }: Readonly<{ type: FlatEntryType; identifier: string; searchParams: SearchParams }>) {
  const user = await requireUser(); let entry;
  try { entry = await new FlatReadService().get(retrievalUser(user), type, identifier, parseFlatSelection(searchParamsUrl("/", await searchParams))); }
  catch (error) { if (error instanceof FlatNotFoundError) notFound(); throw error; }
  return <AppLayout userRole={user.role}><FlatDetail entry={entry} /></AppLayout>;
}
function searchParamsUrl(path: string, params: Awaited<SearchParams>): URL {
  const url = new URL(path, "http://local");
  for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, item);
  return url;
}
