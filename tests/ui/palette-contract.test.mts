import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../../", import.meta.url);
const COLOR_LITERAL = /#[\da-f]{3,8}\b|(?:rgb|rgba|hsl|hsla|hwb|lch|oklch)\([^)]*\)|color\((?!mix\b)[^)]*\)|\b(?:chartreuse|darkgreen|darkolivegreen|green|greenyellow|lightgreen|lime|limegreen|mediumseagreen|olive|olivedrab|seagreen|springgreen|teal|yellowgreen)\b/gi;
const INTERACTIVE_STATUS_SUCCESS = /<(?:button|a|Link|input|select|textarea)\b[^>]*\b(?:bg|text|border|ring|outline|shadow)-status-success(?:\b|\/)[^>]*>/gis;

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

function blend(foreground: string, background: string, opacity: number): string {
  const channels = hexToRgb(foreground).map((channel, index) => Math.round(channel * opacity + hexToRgb(background)[index] * (1 - opacity)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function isGreenLiteral(literal: string): boolean {
  const normalized = literal.toLowerCase();
  if (/^[a-z]+$/.test(normalized)) return true;
  if (normalized.startsWith("hsl")) {
    const match = normalized.match(/hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%/);
    if (!match) return false;
    const hue = ((Number(match[1]) % 360) + 360) % 360;
    return Number(match[2]) > 10 && hue >= 60 && hue <= 190;
  }
  if (normalized.startsWith("hwb")) {
    const match = normalized.match(/hwb\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
    if (!match) return false;
    const hue = ((Number(match[1]) % 360) + 360) % 360;
    return Number(match[2]) + Number(match[3]) < 90 && hue >= 60 && hue <= 190;
  }
  if (normalized.startsWith("lch") || normalized.startsWith("oklch")) {
    const match = normalized.match(/(?:ok)?lch\(\s*[\d.]+%?[\s,]+([\d.]+)[\s,]+(-?[\d.]+)/);
    if (!match) return false;
    const hue = ((Number(match[2]) % 360) + 360) % 360;
    return Number(match[1]) > 0.02 && hue >= 60 && hue <= 190;
  }

  let channels: [number, number, number] | null = null;
  if (normalized.startsWith("rgb")) {
    const values = normalized.match(/[\d.]+%?/g)?.slice(0, 3);
    if (values?.length === 3) channels = values.map((value) => value.endsWith("%") ? Math.round(Number(value.slice(0, -1)) * 2.55) : Number(value)) as [number, number, number];
  } else if (normalized.startsWith("color")) {
    const values = normalized.match(/color\((?:srgb|display-p3)\s+([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/)?.slice(1, 4);
    if (values?.length === 3) channels = values.map((value) => Math.round(Number(value) * 255)) as [number, number, number];
  } else if (normalized.startsWith("#")) {
    const raw = normalized.slice(1);
    const expanded = raw.length === 3 || raw.length === 4 ? raw.slice(0, 3).split("").map((value) => value.repeat(2)).join("") : raw.slice(0, 6);
    if (expanded.length === 6) channels = hexToRgb(`#${expanded}`);
  }
  if (!channels) return false;

  const [red, green, blue] = channels.map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  if (maximum === minimum) return false;
  const hue = maximum === red
    ? 60 * (((green - blue) / (maximum - minimum)) % 6)
    : maximum === green
      ? 60 * ((blue - red) / (maximum - minimum) + 2)
      : 60 * ((red - green) / (maximum - minimum) + 4);
  const normalizedHue = (hue + 360) % 360;
  return (maximum - minimum) / maximum > 0.1 && normalizedHue >= 60 && normalizedHue <= 190;
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
    return [".ts", ".tsx", ".js", ".jsx", ".css", ".svg"].includes(extname(path)) ? [path] : [];
  }));
  return nested.flat();
}

describe("shared UI palette", () => {
  it("recognizes legacy green across CSS color syntaxes without classifying warm colors", () => {
    for (const literal of ["#0a1a18", "rgb(61 168 130)", "hsl(160 46% 45%)", "hwb(160 10% 20%)", "oklch(55% 0.12 155)", "color(srgb 0.2 0.6 0.4)", "teal"]) {
      assert.equal(isGreenLiteral(literal), true, literal);
    }
    for (const literal of ["#8a312d", "rgb(138 49 45)", "hsl(2 51% 36%)", "hwb(30 10% 20%)", "oklch(55% 0.12 30)", "color(srgb 0.6 0.2 0.2)"]) {
      assert.equal(isGreenLiteral(literal), false, literal);
    }
  });

  it("removes legacy brand greens and reserves green for status-success", async () => {
    const paths = (await Promise.all([
      sourceFiles(new URL("src/app", ROOT).pathname),
      sourceFiles(new URL("src/components", ROOT).pathname),
    ])).flat();
    const sources = await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")] as const));

    for (const [path, source] of sources) {
      assert.doesNotMatch(source, /--color-success\b|\b(?:bg|text|border)-success(?:\b|\/)/, path);
      assert.doesNotMatch(source, INTERACTIVE_STATUS_SUCCESS, `${path}: status-success is passive state, not an action color`);
      const declarations = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
      for (const line of declarations.split("\n")) {
        const greenLiterals = [...line.matchAll(COLOR_LITERAL)].map((match) => match[0]).filter(isGreenLiteral);
        if (greenLiterals.length > 0) assert.match(line, /--color-status-success:/, `${path}: green ${greenLiterals.join(", ")} is not a status-success token`);
      }
    }

    const css = sources.find(([path]) => path.endsWith("globals.css"))?.[1] ?? "";
    assert.match(css, /--color-status-success:\s*#76b783/);
    assert.match(css, /\.app-parchment\s*\{[\s\S]*--color-status-success:\s*#2d5938/);
  });

  it("keeps solid and translucent semantic colors above WCAG AA", async () => {
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
    for (const background of [token(dark, "page"), token(parchment, "surface")]) {
      for (const opacity of [0.1, 0.15]) {
        assert.ok(contrast(token(parchment, "warning"), blend(token(parchment, "warning"), background, opacity)) >= 4.5);
        assert.ok(contrast(token(parchment, "status-success"), blend(token(parchment, "status-success"), background, opacity)) >= 4.5);
      }
    }
    assert.ok(contrast("#ffffff", token(parchment, "warning")) >= 4.5);
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
    assert.doesNotMatch(`${loginForm}\n${registerForm}`, /status-success/);
    assert.match(css, /@media \(max-width: 61\.999rem\)[\s\S]*\.mobile-dialog\[open\]/);
    assert.match(css, /@media print[\s\S]*\.mobile-header,[\s\S]*\.mobile-dialog,[\s\S]*display: none !important/);
  });
});
