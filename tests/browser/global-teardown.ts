import { rm } from "node:fs/promises";

export default async function globalTeardown(): Promise<void> {
  await rm("/tmp/dnd-firegory-qa-auth", { recursive: true, force: true });
  await rm("/tmp/dnd-firegory-qa-storage", { recursive: true, force: true });
}
