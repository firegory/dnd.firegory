import type { SeedSlotResult } from "./executor.ts";

export function seedCommandIncomplete(command: string | null, results: readonly SeedSlotResult[]): boolean {
  return results.some(({ operation, counts }) => operation === "failed"
    || command === "status" && (operation !== "noop" || counts.imported !== counts.discovered
      || counts.reviewed !== counts.discovered || counts.published !== counts.discovered || counts.indexed !== counts.discovered));
}
