const REDIRECT_BASE = "https://dnd.firegory.invalid";

/** Accepts only an application-local absolute path, preserving query and hash. */
export function validatedRedirectPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048
    || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const parsed = new URL(value, REDIRECT_BASE);
    if (parsed.origin !== REDIRECT_BASE) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
