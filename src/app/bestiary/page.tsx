import { AppLayout } from "../../components/ui/app-layout";
import { requireUser } from "../../server/auth/session";
import { retrievalUser } from "../../server/compendium/http";
import { parseCreatureListOptions } from "../../server/compendium/creature-http";
import { CreatureReadService } from "../../server/compendium/creature-read-service";
import { BestiaryList } from "./bestiary-list";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export default async function BestiaryPage({ searchParams }: Readonly<{ searchParams: SearchParams }>) { const user = await requireUser(); const params = await searchParams; const url = new URL("http://local/bestiary"); for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, item); const options = parseCreatureListOptions(url); const result = await new CreatureReadService().list(retrievalUser(user), options); if (result.nextCursor) url.searchParams.set("cursor", result.nextCursor); return <AppLayout userRole={user.role}><BestiaryList creatures={result.creatures} count={result.count} options={options} nextHref={result.nextCursor ? `/bestiary?${url.searchParams}` : null} /></AppLayout>; }
