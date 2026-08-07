import { notFound } from "next/navigation";
import { AppLayout } from "../../../components/ui/app-layout";
import { requireUser } from "../../../server/auth/session";
import { retrievalUser } from "../../../server/compendium/http";
import { CreatureNotFoundError, CreatureReadService } from "../../../server/compendium/creature-read-service";
import { BestiaryDetail } from "./bestiary-detail";
export default async function BestiaryDetailPage({ params }: Readonly<{ params: Promise<{ identifier: string }> }>) { const user = await requireUser(); let creature; try { const { identifier } = await params; creature = await new CreatureReadService().get(retrievalUser(user), identifier); } catch (error) { if (error instanceof CreatureNotFoundError) notFound(); throw error; } return <AppLayout userRole={user.role}><BestiaryDetail creature={creature} /></AppLayout>; }
