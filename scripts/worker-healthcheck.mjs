import { readdir, readFile } from "node:fs/promises";

const processes = await readdir("/proc", { withFileTypes: true });
for (const processEntry of processes) {
  if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) continue;
  try {
    const command = await readFile(`/proc/${processEntry.name}/cmdline`, "utf8");
    if (command.split("\0").includes("src/worker/index.ts")) process.exit(0);
  } catch {
    // Processes can exit while /proc is being scanned.
  }
}
process.exit(1);
