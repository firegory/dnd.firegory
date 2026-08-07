import { FlatDetailPage } from "../../flat-compendium/pages";
export default async function Page({ params }: { params: Promise<{ identifier: string }> }) { return <FlatDetailPage type="background" identifier={(await params).identifier} />; }
