import { redirect } from "next/navigation";

export default function MockHomePage() {
  redirect("/mock/search");
}
