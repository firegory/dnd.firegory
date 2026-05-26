import { redirect } from "next/navigation";
import { ENTITY_CONFIG, ENTITY_TYPES } from "../../server/entities/types";

export default function BrowsePage() {
  const firstSlug = ENTITY_CONFIG[ENTITY_TYPES[0]].slug;
  redirect(`/browse/${firstSlug}`);
}
