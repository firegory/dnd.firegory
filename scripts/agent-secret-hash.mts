import { createHash } from "node:crypto";

const chunks: Buffer[] = [];
let length = 0;
for await (const chunk of process.stdin) {
  const bytes = Buffer.from(chunk);
  length += bytes.length;
  if (length > 4096) throw new Error("Secret input exceeds 4096 bytes.");
  chunks.push(bytes);
}
const secret = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Secret must contain at least 32 bytes.");
process.stdout.write(`${createHash("sha256").update(secret).digest("hex")}\n`);
