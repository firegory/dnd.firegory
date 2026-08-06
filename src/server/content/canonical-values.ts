export const PLAIN_UUID_PATTERN = "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$";

const PLAIN_UUID = new RegExp(PLAIN_UUID_PATTERN);
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

export function normalizePlainUuid(value: string): string | null {
  if (!PLAIN_UUID.test(value)) return null;
  return value.toLowerCase();
}

export function normalizeCanonicalHttpUrl(value: string): string | null {
  if (
    /\s/.test(value)
    || INVALID_PERCENT_ESCAPE.test(value)
    || !/^https?:\/\/[^%\s/?#]+/i.test(value)
  ) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host === "") return null;
  return parsed.href;
}
