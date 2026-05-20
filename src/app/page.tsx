import { redirect } from "next/navigation";

import { requireUser } from "../server/auth/session";

export default async function Home() {
  await requireUser();
  redirect("/search");
}
