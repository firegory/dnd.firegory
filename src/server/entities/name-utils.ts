export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s\-_]+/g, " ")
    .replace(/[()\"']/g, "");
}

export function namesCouldMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 2 || b.length < 2) return false;

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (shorter.length / longer.length < 0.4) return false;

  if (a.includes(b) || b.includes(a)) return true;

  const commonPrefixLen = (() => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  })();
  if (commonPrefixLen / longer.length >= 0.5) return true;

  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const c of setA) if (setB.has(c)) shared++;
  if (shared / Math.max(setA.size, setB.size) < 0.4) return false;

  return true;
}
