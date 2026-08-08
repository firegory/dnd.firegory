import { lstat, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = process.argv[2];
if (!root || !root.startsWith("/")) throw new Error("Usage: node scripts/filesystem-manifest.mjs <absolute-root>");

const entries = [];
async function walk(relative) {
  const absolute = resolve(root, relative);
  const stat = await lstat(absolute);
  const pathBase64 = Buffer.from(relative).toString("base64");
  const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
  if (stat.isDirectory()) {
    if (relative) entries.push({ pathBase64, type: "directory", mode });
    const children = await readdir(absolute);
    children.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const child of children) await walk(relative ? `${relative}/${child}` : child);
    return;
  }
  if (stat.isFile()) {
    entries.push({ pathBase64, type: "file", mode, size: stat.size });
    return;
  }
  if (stat.isSymbolicLink()) {
    entries.push({ pathBase64, type: "symlink", mode, targetBase64: Buffer.from(await readlink(absolute)).toString("base64") });
    return;
  }
  throw new Error(`Unsupported filesystem object in canonical repository: ${relative}`);
}

await walk("");
for (const entry of entries) process.stdout.write(`${JSON.stringify(entry)}\n`);
