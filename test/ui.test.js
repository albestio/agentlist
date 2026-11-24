import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const readSource = (name) => readFileSync(join(publicDir, name), "utf8");

const html = readSource("index.html");
const css = readSource("styles.css");
const app = readSource("app.js");

const tokenBlock = css.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] || "";

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

function tokenPair(name) {
  const declaration = tokenBlock.match(new RegExp(`--${name}\\s*:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{3,8})\\s*,\\s*(#[0-9a-fA-F]{3,8})\\s*\\)`));
  assert.ok(declaration, `token --${name} must pair a light and a dark value`);
  return { light: declaration[1], dark: declaration[2] };
}

function luminance(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((digit) => digit + digit).join("");
  const [r, g, b] = [0, 2, 4]
    .map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("the drawer is a native dialog, not a hand-rolled modal", () => {
  assert.match(html, /<dialog\b/);
  assert.match(html, /<dialog[^>]*id="drawer"[^>]*closedby="any"/);
  assert.match(html, /id="drawer"[^>]*aria-labelledby="drawer-title"/);
  assert.equal(html.includes("aria-modal"), false, "a native dialog already makes the page inert");
  assert.equal(html.includes('role="dialog"'), false, "the dialog element supplies its own role");
  assert.equal(html.includes("drawer-backdrop"), false, "no backdrop element: ::backdrop replaces it");
  assert.equal(app.includes("lockPageScroll"), false, "no overflow:hidden page lock");
  assert.equal(countMatches(app, /\.showModal\(\)/g), 1);
  assert.equal(countMatches(app, /\.close\(\)/g), 1);
});

test("the tab list keeps two real tabs with roving tabindex", () => {
  const navStart = html.indexOf('role="tablist"');
  assert.ok(navStart > 0, "the tab list keeps its role");
  const nav = html.slice(navStart, html.indexOf("</nav>", navStart));
  assert.equal(countMatches(nav, /role="tab"/g), 2, "exactly two tabs");
  assert.match(nav, /role="tab"[^>]*tabindex="0"/);
  assert.match(nav, /role="tab"[^>]*tabindex="-1"/);
  assert.equal(html.includes("aria-controls"), false, "aria-controls is dropped");
  assert.equal(countMatches(html, /role="tabpanel"/g), 2);
  assert.equal(countMatches(html, /hidden="until-found"/g), 1, "the inactive panel stays findable");
  assert.match(app, /beforematch/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /"Home"/);
  assert.match(app, /"End"/);
});

test("the agent list is list/li/button without interactive ARIA roles", () => {
  assert.match(html, /<ul id="list"/);
  assert.equal(html.includes('role="list"'), false);
  assert.equal(app.includes('role="listitem"'), false);
  assert.match(app, /node\("li"/);
  assert.match(app, /node\("button"/);
});

test("one debounced live region announces the counts", () => {
  assert.equal(countMatches(html, /aria-live=/g), 1);
  assert.match(html, /<p class="sr-only" id="status" role="status" aria-live="polite"><\/p>/);
  assert.match(html, /id="count"><\/p>/);
  assert.match(html, /id="doc-count"><\/p>/);
  assert.match(app, /setTimeout\([\s\S]*?250\)/);
});

test("no raw hex colour survives outside the token block", () => {
  assert.ok(tokenBlock, "styles.css declares its tokens in :root");
  const outsideTokens = css.replace(tokenBlock, "");
  assert.deepEqual(outsideTokens.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "every colour comes from a token");
});

test("theme tokens pair light and dark and controls keep a 3:1 boundary", () => {
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<meta name="text-scale" content="scale">/);
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/);

  const declarations = tokenBlock.match(/--[\w-]+\s*:\s*[^;]+;/g) || [];
  assert.ok(declarations.length >= 15, "the functional tokens are declared once");
  for (const declaration of declarations) {
    assert.match(declaration, /light-dark\(/, declaration);
  }

  const control = tokenPair("borderColor-neutral-emphasis");
  for (const name of ["bgColor-default", "bgColor-muted", "bgColor-inset"]) {
    const surfaces = tokenPair(name);
    assert.ok(contrast(control.light, surfaces.light) >= 3, `light control boundary vs ${name}`);
    assert.ok(contrast(control.dark, surfaces.dark) >= 3, `dark control boundary vs ${name}`);
  }
});

test("reduced motion is scoped and until-found stays findable", () => {
  assert.equal(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*/.test(css), false, "no global reset");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*dialog\.drawer/);
  assert.equal(/\[hidden\]\s*\{\s*display:\s*none/.test(css), false);
  assert.match(css, /\[hidden\]:not\(\[hidden="until-found"\]\)/);
  assert.match(css, /\[hidden="until-found"\]\s*\{\s*content-visibility:\s*hidden/);
  assert.match(css, /100dvh/);
  assert.equal(/\b100vh\b/.test(css), false);
});
