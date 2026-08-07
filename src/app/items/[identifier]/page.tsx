import { FlatDetailPage } from "../../flat-compendium/pages";
export default async function Page({ params }: { params: Promise<{ identifier: string }> }) { return <FlatDetailPage type="item" identifier={(await params).identifier} />; }
