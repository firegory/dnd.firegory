import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../../", import.meta.url);
const LEGACY_GREEN = /#(?:0a1a18|1e3d35|3da882|d4f5e6|8ab8a8|0f2420|163530|e8f5f0|b0d4c8|6a9f90|315747|52715f|edf1e9)\b|rgba\(61,\s*168,\s*130/i;

function hexToRgb(hex: string): [number, number, number] {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function token(block: string, name: string): string {
  const value = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  assert.ok(value, `missing --color-${name}`);
  return value;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".css"].includes(extname(path)) ? [path] : [];
  }));
  return nested.flat();
}

describe("shared UI palette", () => {
  it("removes legacy brand greens and reserves green for status-success", async () => {
    const paths = await sourceFiles(new URL("src", ROOT).pathname);
    const sources = await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")] as const));

    for (const [path, source] of sources) {
      assert.doesNotMatch(source, LEGACY_GREEN, path);
      assert.doesNotMatch(source, /--color-success\b|\b(?:bg|text|border)-success(?:\b|\/)/, path);
    }

    const css = sources.find(([path]) => path.endsWith("globals.css"))?.[1] ?? "";
    assert.match(css, /--color-status-success:\s*#76b783/);
    assert.match(css, /\.app-parchment\s*\{[\s\S]*--color-status-success:\s*#32633f/);
  });

  it("keeps dark-shell and parchment text, actions, success, and focus above WCAG AA", async () => {
    const css = await readFile(new URL("src/app/globals.css", ROOT), "utf8");
    const dark = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const parchment = css.match(/\.app-parchment\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";

    assert.ok(contrast(token(dark, "text-primary"), token(dark, "surface")) >= 4.5);
    assert.ok(contrast(token(dark, "text-muted"), token(dark, "primary")) >= 4.5);
    assert.ok(contrast(token(dark, "focus"), token(dark, "surface")) >= 3);
    assert.ok(contrast(token(dark, "primary"), token(dark, "accent")) >= 4.5);
    assert.ok(contrast(token(parchment, "focus"), token(dark, "page")) >= 3);
    assert.ok(contrast(token(parchment, "highlight"), token(parchment, "accent")) >= 4.5);
    assert.ok(contrast(token(parchment, "status-success"), token(dark, "page")) >= 4.5);
  });

  it("applies parchment auth, shared focus tokens, responsive chrome, and print removal", async () => {
    const [css, loginPage, registerPage, loginForm, registerForm] = await Promise.all([
      readFile(new URL("src/app/globals.css", ROOT), "utf8"),
      readFile(new URL("src/app/login/page.tsx", ROOT), "utf8"),
      readFile(new URL("src/app/register/page.tsx", ROOT), "utf8"),
      readFile(new URL("src/app/login/login-form.tsx", ROOT), "utf8"),
      readFile(new URL("src/app/register/register-form.tsx", ROOT), "utf8"),
    ]);

    assert.match(loginPage, /className="app-parchment[^"\n]*bg-primary/);
    assert.match(registerPage, /className="app-parchment[^"\n]*bg-primary/);
    assert.match(loginForm, /focus:border-focus focus:ring-2 focus:ring-focus\/20/);
    assert.match(registerForm, /focus:border-focus focus:ring-2 focus:ring-focus\/20/);
    assert.match(css, /@media \(max-width: 61\.999rem\)[\s\S]*\.mobile-dialog\[open\]/);
    assert.match(css, /@media print[\s\S]*\.mobile-header,[\s\S]*\.mobile-dialog,[\s\S]*display: none !important/);
  });
});
