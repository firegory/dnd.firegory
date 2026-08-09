import { open, stat } from "node:fs/promises";

import { MAX_PDF_INPUT_BYTES } from "../../server/ingestion/limits.ts";

const PDF_MAGIC = Buffer.from("%PDF-");

export async function assertBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<number> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
  if (metadata.size > maxBytes) throw new Error(`${label} exceeds size limit of ${maxBytes} bytes`);
  return metadata.size;
}

export async function validateOriginalPdf(path: string): Promise<number> {
  const size = await assertBoundedFile(path, MAX_PDF_INPUT_BYTES, "Original PDF");
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(PDF_MAGIC.length);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== PDF_MAGIC.length || !magic.equals(PDF_MAGIC)) {
      throw new Error("File is not a valid PDF (missing %PDF- header)");
    }
  } finally {
    await handle.close();
  }
  return size;
}

export async function readBoundedUtf8(path: string, maxBytes: number, label: string): Promise<string> {
  const size = await assertBoundedFile(path, maxBytes, label);
  const handle = await open(path, "r");
  try {
    const output = Buffer.alloc(size);
    const { bytesRead } = await handle.read(output, 0, size, 0);
    return output.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
