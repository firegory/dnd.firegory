import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const storageRoot = "/app/storage";
const sourcePath = `${storageRoot}/originals/seed.pdf`;
const cacheRoot = `${storageRoot}/processed/seed/previews`;
const outputPrefix = `${cacheRoot}/page-1`;

if (process.getuid?.() !== 10001 || process.getgid?.() !== 10001) {
  throw new Error("Production preview smoke must run as UID/GID 10001.");
}

await assertReadOnlyRoot();
await mkdir(`${storageRoot}/originals`, { recursive: true });
await mkdir(cacheRoot, { recursive: true });
await writeFile(sourcePath, minimalPdf());

run("pdfinfo", [sourcePath]);
run("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-scale-to", "1400", "-png", sourcePath, outputPrefix]);

const image = await readFile(`${outputPrefix}.png`);
const decoded = decodePng(image);
if (decoded.width < 100 || decoded.height < 100 || decoded.darkPixels < 1) {
  throw new Error("Production PDF preview did not contain decoded source pixels.");
}
console.log(JSON.stringify({ event: "production_preview_smoke", ...decoded, bytes: image.byteLength, uid: process.getuid() }));

async function assertReadOnlyRoot() {
  const probe = "/app/.preview-write-probe";
  try {
    await writeFile(probe, "must fail");
    await rm(probe, { force: true });
    throw new Error("Production root filesystem is writable.");
  } catch (error) {
    if (error instanceof Error && error.message === "Production root filesystem is writable.") throw error;
  }
  await writeFile("/tmp/preview-tmpfs-probe", "ok");
  await rm("/tmp/preview-tmpfs-probe");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed in the production image.`);
}

function decodePng(image) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!image.subarray(0, 8).equals(signature)) throw new Error("Renderer output is not PNG.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.subarray(offset + 4, offset + 8).toString("ascii");
    const data = image.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("Interlaced PNG is not supported by the smoke decoder.");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const channels = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]).get(colorType);
  if (!channels || bitDepth !== 8 || width < 1 || height < 1 || idat.length === 0) throw new Error("Unsupported renderer PNG format.");
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (packed.length !== (stride + 1) * height) throw new Error("Unexpected decoded PNG size.");
  let previous = Buffer.alloc(stride);
  let darkPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const packedOffset = y * (stride + 1);
    const filter = packed[packedOffset];
    const row = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = packed[packedOffset + 1 + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      row[x] = (raw + predictor(filter, left, up, upperLeft)) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const pixel = x * channels;
      const red = row[pixel];
      const green = colorType === 0 || colorType === 4 ? red : row[pixel + 1];
      const blue = colorType === 0 || colorType === 4 ? red : row[pixel + 2];
      if (red < 240 || green < 240 || blue < 240) darkPixels += 1;
    }
    previous = row;
  }
  return { width, height, darkPixels };
}

function predictor(filter, left, up, upperLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter !== 4) throw new Error("Unknown PNG filter.");
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function minimalPdf() {
  const stream = "BT /F1 18 Tf 40 160 Td (QA citation preview pixels) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
