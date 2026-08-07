import { notFound } from "next/navigation";
import { AppLayout } from "../../../components/ui/app-layout";
import { requireUser } from "../../../server/auth/session";
import { parseSelection, retrievalUser } from "../../../server/compendium/http";
import { CreatureNotFoundError, CreatureReadService } from "../../../server/compendium/creature-read-service";
import { BestiaryDetail } from "./bestiary-detail";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export default async function BestiaryDetailPage({ params, searchParams }: Readonly<{ params: Promise<{ identifier: string }>; searchParams: SearchParams }>) { const user = await requireUser(); const query=await searchParams; const url=new URL("http://local/bestiary"); for(const [key,value] of Object.entries(query))for(const item of Array.isArray(value)?value:value===undefined?[]:[value])url.searchParams.append(key,item); let creature; try { const { identifier } = await params; creature = await new CreatureReadService().get(retrievalUser(user), identifier, parseSelection(url)); } catch (error) { if (error instanceof CreatureNotFoundError) notFound(); throw error; } return <AppLayout userRole={user.role}><BestiaryDetail creature={creature} returnHref={`/bestiary${url.search ? url.search : ""}`} /></AppLayout>; }
