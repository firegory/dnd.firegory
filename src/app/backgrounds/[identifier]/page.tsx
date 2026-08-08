import { FlatDetailPage } from "../../flat-compendium/pages";
export default async function Page({ params, searchParams }: { params: Promise<{ identifier: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) { return <FlatDetailPage type="background" identifier={(await params).identifier} searchParams={searchParams} />; }
