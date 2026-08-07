import { FlatDetailPage } from "../../flat-compendium/pages";
export default async function Page({ params }: { params: Promise<{ identifier: string }> }) { return <FlatDetailPage type="equipment" identifier={(await params).identifier} />; }
