import { createHmac, timingSafeEqual } from "node:crypto";

import { readSecret } from "./config.ts";
import { invalidRequest } from "./errors.ts";

const MAX_CURSOR_BYTES = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export type CursorKind = "entries" | "search" | "changes";
export type CursorData = Readonly<{ key: string; id: string; rank?: number; changedAt?: string }>;

export class CursorCodec {
  private readonly secret: string;

  constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Cursor secret must contain at least 32 bytes.");
    this.secret = secret;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): CursorCodec {
    return new CursorCodec(readSecret("AGENT_GATEWAY_CURSOR_SECRET", "AGENT_GATEWAY_CURSOR_SECRET_FILE", environment));
  }

  encode(kind: CursorKind, binding: Readonly<Record<string, unknown>>, data: CursorData): string {
    validateData(kind, data);
    const payload = Buffer.from(JSON.stringify({ v: 1, kind, binding: bindingDigest(binding), data }), "utf8").toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  decode(kind: CursorKind, binding: Readonly<Record<string, unknown>>, token: string | undefined): CursorData | null {
    if (!token) return null;
    try {
      if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error();
      const expected = this.sign(parts[0]);
      const signature = Buffer.from(parts[1]);
      const expectedBytes = Buffer.from(expected);
      if (signature.length !== expectedBytes.length || !timingSafeEqual(signature, expectedBytes)) throw new Error();
      const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
      if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["v", "kind", "binding", "data"])) throw new Error();
      if (parsed.v !== 1 || parsed.kind !== kind || parsed.binding !== bindingDigest(binding) || !isRecord(parsed.data)) throw new Error();
      if (!hasOnlyKeys(parsed.data, kind === "search" ? ["key", "id", "rank"] : kind === "changes" ? ["key", "id", "changedAt"] : ["key", "id"])) throw new Error();
      const data = parsed.data as CursorData;
      validateData(kind, data);
      return data;
    } catch {
      throw invalidRequest("cursor is invalid, expired, or does not match this operation and filter set.");
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

function validateData(kind: CursorKind, data: CursorData): void {
  if (typeof data.key !== "string" || !STABLE_ID_RE.test(data.key)) throw new Error();
  if (typeof data.id !== "string" || !UUID_RE.test(data.id)) throw new Error();
  if (kind === "search" && (typeof data.rank !== "number" || !Number.isFinite(data.rank) || data.rank < 0)) throw new Error();
  if (kind === "changes") {
    if (typeof data.changedAt !== "string") throw new Error();
    const date = new Date(data.changedAt);
    if (!Number.isFinite(date.valueOf()) || date.toISOString() !== data.changedAt) throw new Error();
  }
}

function bindingDigest(binding: Readonly<Record<string, unknown>>): string {
  return createHmac("sha256", "dnd-firegory-agent-cursor-binding-v1").update(JSON.stringify(binding)).digest("base64url");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
