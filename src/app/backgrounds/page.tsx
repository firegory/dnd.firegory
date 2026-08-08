import { FlatListPage } from "../flat-compendium/pages";
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) { return <FlatListPage type="background" searchParams={searchParams} />; }
