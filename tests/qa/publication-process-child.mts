import { readFile } from "node:fs/promises";

import type { PublicationCommand } from "../../src/server/content-storage/publication-command.ts";
import type { PublicationFenceManager } from "../../src/worker/publication/fence.ts";
import type { PublicationLeaseManager } from "../../src/worker/publication/lease.ts";
import { publishCanonicalRevision } from "../../src/worker/publication/publisher.ts";

const [root, commandPath, mode] = process.argv.slice(2);
if (!root || !commandPath || !["crash", "retry"].includes(mode)) throw new Error("root, command path, and mode are required");
const command = JSON.parse(await readFile(commandPath, "utf8")) as PublicationCommand;

const leaseManager: PublicationLeaseManager = {
  async acquire() {
    return { ownerId: "qa-process-owner", renew: async () => true, release: async () => true };
  },
};
const fenceManager: PublicationFenceManager = {
  async acquire() {
    return { verify: async () => undefined, release: async () => undefined };
  },
};

await publishCanonicalRevision({
  dataRoot: root,
  command,
  leaseManager,
  fenceManager,
  hooks: mode === "crash" ? {
    async afterActivationTemporarySynced() {
      process.send?.("activation-temporary-synced");
      await new Promise<never>(() => setInterval(() => undefined, 60_000));
    },
  } : undefined,
});
process.send?.("completed");
