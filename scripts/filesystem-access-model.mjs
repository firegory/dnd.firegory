import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

if (process.argv[2] === "--validate") {
  const [, , , manifestPath, expectedUid, expectedGid] = process.argv;
  if (!manifestPath || !/^\d+$/.test(expectedUid ?? "") || !/^\d+$/.test(expectedGid ?? "")) {
    throw new Error("Usage: node scripts/filesystem-access-model.mjs --validate <manifest> <uid> <gid>");
  }
  const model = JSON.parse(await readFile(manifestPath, "utf8"));
  if (model.schemaVersion !== 1 || !Array.isArray(model.identities) || model.identities.length !== 1) {
    throw new Error("Archive fallback requires exactly one canonical UID/GID identity");
  }
  if (model.hasExtendedAcl !== false || model.hasExtendedXattr !== false) {
    throw new Error("Archive fallback does not support extended ACLs or xattrs");
  }
  const identity = model.identities[0];
  if (identity.uid !== Number(expectedUid) || identity.gid !== Number(expectedGid)) {
    throw new Error("Canonical archive identity does not match the effective service identity");
  }
  process.stdout.write("Canonical archive uses one compatible service identity.\n");
  process.exit(0);
}

const root = process.argv[2];
if (!root || !root.startsWith("/")) throw new Error("Usage: node scripts/filesystem-access-model.mjs <absolute-root>");
const hasExtendedAcl = process.env.DND_FILESYSTEM_HAS_EXTENDED_ACL;
const hasExtendedXattr = process.env.DND_FILESYSTEM_HAS_EXTENDED_XATTR;
if (!["true", "false"].includes(hasExtendedAcl ?? "") || !["true", "false"].includes(hasExtendedXattr ?? "")) {
  throw new Error("DND_FILESYSTEM_HAS_EXTENDED_ACL and DND_FILESYSTEM_HAS_EXTENDED_XATTR must be true or false");
}
const identities = new Set();
async function walk(relative) {
  const absolute = resolve(root, relative);
  const stat = await lstat(absolute);
  if (relative) identities.add(`${stat.uid}:${stat.gid}`);
  if (!stat.isDirectory()) return;
  for (const child of await readdir(absolute)) await walk(relative ? `${relative}/${child}` : child);
}
await walk("");
const rows = [...identities].map((identity) => {
  const [uid, gid] = identity.split(":").map(Number);
  return { uid, gid };
}).sort((left, right) => left.uid - right.uid || left.gid - right.gid);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  identities: rows,
  hasExtendedAcl: hasExtendedAcl === "true",
  hasExtendedXattr: hasExtendedXattr === "true",
}, null, 2)}\n`);
